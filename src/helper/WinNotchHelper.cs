// WinNotch's native sidecar: reads the hinge angle and reports / controls media.
//
// Replaces two PowerShell processes (hinge-sensor.ps1, media-helper.ps1) that
// each carried a ~60 MB PowerShell runtime to do very little. Compiled with the
// C# compiler that ships with Windows (see scripts/build-helper.js).
//
// stdout, one line each:
//   ANGLE <degrees> <motion>
//                     hinge angle, on change, while the hinge is switched on;
//                     motion is how far (in g) the base accelerometer has swung
//                     from its resting reading recently — non-zero means the
//                     laptop itself is moving, not just the lid
//   META <json>       current media ({} when nothing is playing), on change
//   ART <base64>      artwork for the current media, in reply to "art"
//   SHOT <id> <b64>   half-resolution JPEG of the primary screen, in reply to
//                     "shot <id>" (empty when the capture failed)
// stdin, one command per line:
//   hinge on | hinge off | shot <id> | art | play | pause | next | prev | toggle
// The helper exits when stdin closes, so it never outlives the app.

using System;
using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;

static class Program {
    static readonly object OutLock = new object();
    static volatile bool hingeOn;
    static readonly BlockingCollection<string> MediaCommands = new BlockingCollection<string>();

    static void Send(string line) {
        lock (OutLock) { Console.Out.WriteLine(line); Console.Out.Flush(); }
    }

    static void Log(string line) {
        lock (OutLock) { Console.Error.WriteLine(line); Console.Error.Flush(); }
    }

    // The hinge sensor is a COM object that wants an STA thread, so the hinge
    // loop owns the main thread; media and stdin each get their own.
    [STAThread]
    static int Main() {
        // Screen captures need real pixels, not the DPI-virtualised size a
        // default process sees; must be set before any DC is touched.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
        Console.OutputEncoding = new UTF8Encoding(false);
        new Thread(ReadCommands) { IsBackground = true, Name = "stdin" }.Start();
        new Thread(MediaLoop) { IsBackground = true, Name = "media" }.Start();
        HingeLoop();
        return 0;
    }

    static void ReadCommands() {
        using (var stdin = new StreamReader(Console.OpenStandardInput())) {
            string line;
            while ((line = stdin.ReadLine()) != null) {
                var cmd = line.Trim();
                if (cmd == "hinge on") hingeOn = true;
                else if (cmd == "hinge off") hingeOn = false;
                else if (cmd.StartsWith("shot ")) {
                    // Off the media thread, which can be busy for a moment and
                    // would hold up the start of the lid effect.
                    var id = cmd.Substring(5).Trim();
                    ThreadPool.QueueUserWorkItem(_ => Send("SHOT " + id + " " + SafeShot()));
                }
                else if (cmd.Length > 0) MediaCommands.Add(cmd);
            }
        }
        Environment.Exit(0);
    }

    // ── Screen capture ───────────────────────────────────────────────────────
    // A plain GDI copy of the composited desktop, scaled to half size as it is
    // copied. Tens of milliseconds, where Electron's desktopCapturer takes
    // 300-450 ms per call — long enough that the lid effect visibly started late.
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] static extern bool SetBrushOrgEx(IntPtr dc, int x, int y, IntPtr prev);
    [DllImport("gdi32.dll")] static extern bool StretchBlt(IntPtr dst, int dx, int dy, int dw, int dh, IntPtr src, int sx, int sy, int sw, int sh, uint rop);

    const int SM_CXSCREEN = 0, SM_CYSCREEN = 1, HALFTONE = 4;
    const uint SRCCOPY = 0x00CC0020, CAPTUREBLT = 0x40000000;
    static readonly ImageCodecInfo JpegCodec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
    static readonly object ShotLock = new object();

    static string SafeShot() {
        try { lock (ShotLock) return Shot(); }
        catch (Exception e) { Log("SHOT_ERR " + e.Message); return ""; }
    }

    static string Shot() {
        int w = GetSystemMetrics(SM_CXSCREEN), h = GetSystemMetrics(SM_CYSCREEN);
        if (w <= 0 || h <= 0) return "";
        int tw = Math.Max(1, w / 2), th = Math.Max(1, h / 2);
        IntPtr screen = GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) return "";
        IntPtr mem = IntPtr.Zero, bmp = IntPtr.Zero;
        try {
            mem = CreateCompatibleDC(screen);
            bmp = CreateCompatibleBitmap(screen, tw, th);
            if (mem == IntPtr.Zero || bmp == IntPtr.Zero) return "";
            IntPtr old = SelectObject(mem, bmp);
            SetStretchBltMode(mem, HALFTONE);
            SetBrushOrgEx(mem, 0, 0, IntPtr.Zero);
            bool ok = StretchBlt(mem, 0, 0, tw, th, screen, 0, 0, w, h, SRCCOPY | CAPTUREBLT);
            SelectObject(mem, old);
            if (!ok) return "";
            using (var image = Image.FromHbitmap(bmp))
            using (var ms = new MemoryStream())
            using (var args = new EncoderParameters(1)) {
                args.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 90L);
                image.Save(ms, JpegCodec, args);
                return Convert.ToBase64String(ms.GetBuffer(), 0, (int)ms.Length);
            }
        } finally {
            if (bmp != IntPtr.Zero) DeleteObject(bmp);
            if (mem != IntPtr.Zero) DeleteDC(mem);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }

    // ── Hinge ────────────────────────────────────────────────────────────────
    static void HingeLoop() {
        bool initTried = false, haveSensor = false;
        double last = double.NaN;
        // Base accelerometer: a slow-moving resting reading, and a peak-held
        // measure of how far the live reading has strayed from it.
        var clock = System.Diagnostics.Stopwatch.StartNew();
        long lastMs = 0;
        double rx = 0, ry = 0, rz = 0, motion = 0;
        bool restInit = false;
        while (true) {
            if (!hingeOn) { last = double.NaN; restInit = false; motion = 0; Thread.Sleep(200); continue; }
            if (!initTried) {
                initTried = true;
                try { haveSensor = HingeReader.Init(); }
                catch (Exception e) { Log("HINGE_ERR init: " + e.Message); }
                if (!haveSensor) Log("HINGE_ERR no hinge sensor on this machine");
            }
            if (haveSensor) {
                double bx, by, bz;
                bool haveBase;
                double a = Math.Round(HingeReader.Read(out bx, out by, out bz, out haveBase), 1);
                long now = clock.ElapsedMilliseconds;
                double dt = Math.Max(1, now - lastMs);
                lastMs = now;
                if (haveBase) {
                    if (!restInit) { rx = bx; ry = by; rz = bz; restInit = true; }
                    double dx = bx - rx, dy = by - ry, dz = bz - rz;
                    double d = Math.Sqrt(dx * dx + dy * dy + dz * dz);
                    // The resting reading follows slowly, so a laptop set down at
                    // a new tilt becomes the new normal within about a second.
                    double k = 1 - Math.Exp(-dt / 800.0);
                    rx += dx * k; ry += dy * k; rz += dz * k;
                    // Peak-held so a jolt keeps counting briefly after it ends,
                    // while the angle it corrupted is still settling.
                    motion = Math.Max(d, motion * Math.Exp(-dt / 300.0));
                }
                if (a >= 0 && a != last) {
                    last = a;
                    Send("ANGLE " + a.ToString(CultureInfo.InvariantCulture) + " " +
                         motion.ToString("0.###", CultureInfo.InvariantCulture));
                }
                Thread.Sleep(33);
            } else {
                Thread.Sleep(1000);
            }
        }
    }

    // ── Media ────────────────────────────────────────────────────────────────
    static T Await<T>(IAsyncOperation<T> op) {
        var until = DateTime.UtcNow.AddSeconds(3);
        while (op.Status == AsyncStatus.Started) {
            if (DateTime.UtcNow > until) { try { op.Cancel(); } catch { } throw new TimeoutException("WinRT call timed out"); }
            Thread.Sleep(5);
        }
        if (op.Status != AsyncStatus.Completed) throw new InvalidOperationException("WinRT call " + op.Status);
        return op.GetResults();
    }

    static void MediaLoop() {
        GlobalSystemMediaTransportControlsSessionManager mgr = null;
        string lastMeta = null;
        var nextPoll = DateTime.MinValue;
        int polls = 0;
        while (true) {
            try {
                if (mgr == null) mgr = Await(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());

                string cmd;
                var wait = nextPoll - DateTime.UtcNow;
                if (MediaCommands.TryTake(out cmd, wait > TimeSpan.Zero ? wait : TimeSpan.Zero)) {
                    if (cmd == "art") { Send("ART " + SafeArt(mgr)); }
                    else if (Control(mgr, cmd)) { nextPoll = DateTime.MinValue; }
                    continue;
                }

                nextPoll = DateTime.UtcNow.AddSeconds(1);
                string meta;
                try { meta = MetaJson(mgr); } catch { meta = "{}"; }
                if (meta != lastMeta) { lastMeta = meta; Send("META " + meta); }
                // WinRT wrappers are only released when collected; a nudge now and
                // then keeps a process that runs for days flat.
                if (++polls % 60 == 0) GC.Collect();
            } catch (Exception e) {
                Log("MEDIA_ERR " + e.Message);
                mgr = null;
                Thread.Sleep(2000);
            }
        }
    }

    // The session most worth showing: playing beats paused, and sessions with a
    // title and artwork beat bare ones.
    static GlobalSystemMediaTransportControlsSession Best(GlobalSystemMediaTransportControlsSessionManager mgr) {
        GlobalSystemMediaTransportControlsSession best = null;
        int bestScore = 0;
        foreach (var s in mgr.GetSessions()) {
            try {
                int score = 0;
                var status = s.GetPlaybackInfo().PlaybackStatus;
                if (status == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing) score += 50;
                else if (status == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused) score += 10;
                var p = Await(s.TryGetMediaPropertiesAsync());
                if (!string.IsNullOrEmpty(p.Title)) score += 20;
                if (p.Thumbnail != null) score += 10;
                if (score > bestScore) { bestScore = score; best = s; }
            } catch { }
        }
        return best;
    }

    static string MetaJson(GlobalSystemMediaTransportControlsSessionManager mgr) {
        var best = Best(mgr);
        if (best == null) return "{}";
        var props = Await(best.TryGetMediaPropertiesAsync());
        var tl = best.GetTimelineProperties();
        bool playing = best.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
        // Players report a position and the moment it was taken, and most of
        // them only refresh it on play, pause or a seek. Sending the age of
        // the reading lets the other side work out where the track really is
        // instead of trusting a number that may be minutes old.
        long ageMs = 0;
        try {
            var age = DateTimeOffset.UtcNow - tl.LastUpdatedTime;
            if (age.TotalMilliseconds > 0 && age.TotalHours < 24) ageMs = (long)age.TotalMilliseconds;
        } catch { }
        return "{\"title\":" + Json(props.Title) +
               ",\"artist\":" + Json(props.Artist) +
               ",\"album\":" + Json(props.AlbumTitle) +
               ",\"playing\":" + (playing ? "true" : "false") +
               ",\"pos\":" + ((long)Math.Floor(tl.Position.TotalSeconds)).ToString(CultureInfo.InvariantCulture) +
               ",\"posAge\":" + ageMs.ToString(CultureInfo.InvariantCulture) +
               ",\"dur\":" + ((long)Math.Floor(tl.EndTime.TotalSeconds)).ToString(CultureInfo.InvariantCulture) +
               ",\"src\":" + Json(best.SourceAppUserModelId) + "}";
    }

    static string SafeArt(GlobalSystemMediaTransportControlsSessionManager mgr) {
        try { return Art(mgr); } catch { return ""; }
    }

    static string Art(GlobalSystemMediaTransportControlsSessionManager mgr) {
        var best = Best(mgr);
        if (best == null) return "";
        var props = Await(best.TryGetMediaPropertiesAsync());
        if (props.Thumbnail == null) return "";
        using (var stream = Await(props.Thumbnail.OpenReadAsync())) {
            ulong size = stream.Size;
            if (size == 0 || size >= 5 * 1024 * 1024) return "";
            using (var reader = new DataReader(stream)) {
                Await(reader.LoadAsync((uint)size));
                var bytes = new byte[size];
                reader.ReadBytes(bytes);
                return Convert.ToBase64String(bytes);
            }
        }
    }

    static bool Control(GlobalSystemMediaTransportControlsSessionManager mgr, string cmd) {
        bool seek = cmd.StartsWith("seek ");
        if (!seek && cmd != "play" && cmd != "pause" && cmd != "next" && cmd != "prev" && cmd != "toggle") return false;
        var best = Best(mgr);
        if (best == null) return false;
        try {
            if (seek) {
                double seconds;
                if (!double.TryParse(cmd.Substring(5), NumberStyles.Float, CultureInfo.InvariantCulture, out seconds)
                    || seconds < 0 || double.IsNaN(seconds) || double.IsInfinity(seconds)) return true;
                // The position is in 100-nanosecond ticks.
                Await(best.TryChangePlaybackPositionAsync((long)(seconds * 10000000.0)));
                return true;
            }
            switch (cmd) {
                case "play":  Await(best.TryPlayAsync()); break;
                case "pause": Await(best.TryPauseAsync()); break;
                case "next":  Await(best.TrySkipNextAsync()); break;
                case "prev":  Await(best.TrySkipPreviousAsync()); break;
                default:      Await(best.TryTogglePlayPauseAsync()); break;
            }
        } catch (Exception e) { Log("MEDIA_ERR " + cmd + ": " + e.Message); }
        return true;
    }

    static string Json(string s) {
        if (s == null) return "\"\"";
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char c in s) {
            switch (c) {
                case '"':  sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20 || c == '\u2028' || c == '\u2029') sb.AppendFormat("\\u{0:x4}", (int)c);
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}

// ── Hinge sensor (Win32 COM Sensor API) ─────────────────────────────────────
// The angle comes from the "Hinge Sensor". It is NOT reachable through WinRT's
// HingeAngleSensor: Lenovo registers it as a custom sensor type, and WinRT only
// projects the sensor types it knows about.
//
// PROPVARIANT must be 24 bytes on x64. Sizing it any smaller makes every
// GetSensorValue call fail with ERROR_NOT_FOUND on every sensor, which looks
// exactly like "this machine has no sensor data".

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public short iVal;
    [FieldOffset(8)] public int lVal;
    [FieldOffset(8)] public uint ulVal;
    [FieldOffset(8)] public float fltVal;
    [FieldOffset(8)] public double dblVal;
    [FieldOffset(16)] public IntPtr pad2;
}

[StructLayout(LayoutKind.Sequential)]
public struct SYSTEMTIME { public ushort y, mo, dow, d, h, mi, s, ms; }

[ComImport, Guid("BD77DB67-45A8-42DC-8D00-6DCF15F8377A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISensorManager {
    void GetSensorsByCategory([In] ref Guid cat, [MarshalAs(UnmanagedType.Interface)] out ISensorCollection col);
    void GetSensorsByType([In] ref Guid type, [MarshalAs(UnmanagedType.Interface)] out ISensorCollection col);
    void GetSensorByID([In] ref Guid id, [MarshalAs(UnmanagedType.Interface)] out ISensor s);
}

[ComImport, Guid("23571E11-E545-4DD8-A337-B89BF44B10DF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISensorCollection {
    void GetAt([In] uint idx, [MarshalAs(UnmanagedType.Interface)] out ISensor s);
    void GetCount(out uint count);
}

[ComImport, Guid("DADA2357-E0AD-492E-98DB-DD61C53BA353"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPortableDeviceKeyCollection {
    void GetCount(out uint c);
    void GetAt([In] uint idx, out PROPERTYKEY key);
    void Add([In] ref PROPERTYKEY key);
    void Clear();
    void RemoveAt([In] uint idx);
}

[ComImport, Guid("0AB9DF9B-C4B5-4796-8898-0470706A2E1D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISensorDataReport {
    void GetTimestamp(out SYSTEMTIME ts);
    void GetSensorValue([In] ref PROPERTYKEY key, out PROPVARIANT val);
    void GetSensorValues([In] IntPtr keys, out IntPtr vals);
}

[ComImport, Guid("5FA08F80-2657-458E-AF75-46F73FA6AC5C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISensor {
    void GetID(out Guid id);
    void GetCategory(out Guid cat);
    void GetSensorType(out Guid type);
    void GetFriendlyName([MarshalAs(UnmanagedType.BStr)] out string name);
    void GetProperty([In] ref PROPERTYKEY key, out PROPVARIANT val);
    void GetProperties([In] IntPtr keys, out IntPtr vals);
    void GetSupportedDataFields([MarshalAs(UnmanagedType.Interface)] out IPortableDeviceKeyCollection fields);
    void SetProperties([In] IntPtr props, out IntPtr results);
    void SupportsDataField([In] ref PROPERTYKEY key, out short supported);
    void GetState(out int state);
    void GetData([MarshalAs(UnmanagedType.Interface)] out ISensorDataReport report);
}

public static class HingeReader {
    // Lenovo's hinge report: pid 7 is the angle, pids 10-12 the lid
    // accelerometer and pids 13-15 the base accelerometer (in g). Checked
    // against the physical sensors: 13-15 match the LIS2DWL, which reads ~1g
    // along Z with the laptop on a desk, so it sits in the base.
    const uint ANGLE_PID = 7, BASE_X_PID = 13;
    static ISensor _sensor;
    static PROPERTYKEY _angleKey;
    static bool _haveKey;
    static readonly PROPERTYKEY[] _baseKeys = new PROPERTYKEY[3];
    static int _baseFound;

    public static bool Init() {
        Type t = Type.GetTypeFromCLSID(new Guid("77A1C827-FCD2-4689-8915-9D613CC5FA3E"));
        ISensorManager mgr = (ISensorManager)Activator.CreateInstance(t);
        Guid all = new Guid("C317C286-C468-4288-9975-D4C4587C442C");
        ISensorCollection col;
        mgr.GetSensorsByCategory(ref all, out col);
        uint count;
        col.GetCount(out count);
        for (uint i = 0; i < count; i++) {
            ISensor s;
            col.GetAt(i, out s);
            string name = null;
            try { s.GetFriendlyName(out name); } catch { }
            if (name == null || name.IndexOf("Hinge", StringComparison.OrdinalIgnoreCase) < 0) continue;

            IPortableDeviceKeyCollection fields;
            s.GetSupportedDataFields(out fields);
            uint fc;
            fields.GetCount(out fc);
            _baseFound = 0;
            for (uint f = 0; f < fc; f++) {
                PROPERTYKEY k;
                fields.GetAt(f, out k);
                if (k.pid == ANGLE_PID) { _angleKey = k; _haveKey = true; }
                else if (k.pid >= BASE_X_PID && k.pid <= BASE_X_PID + 2) {
                    _baseKeys[k.pid - BASE_X_PID] = k;
                    _baseFound |= 1 << (int)(k.pid - BASE_X_PID);
                }
            }
            if (_haveKey) { _sensor = s; return true; }
        }
        return false;
    }

    static double Value(PROPVARIANT v) {
        switch (v.vt) {
            case 2:  return v.iVal;
            case 3:  return v.lVal;
            case 4:  return v.fltVal;
            case 5:  return v.dblVal;
            case 19: return v.ulVal;
            default: return double.NaN;
        }
    }

    // Returns the hinge angle in degrees, or -1 when unreadable. The base
    // accelerometer comes from the same report, so it costs no extra call;
    // haveBase is false on hardware that doesn't report it.
    public static double Read(out double bx, out double by, out double bz, out bool haveBase) {
        bx = by = bz = 0;
        haveBase = false;
        try {
            ISensorDataReport rep;
            _sensor.GetData(out rep);
            PROPVARIANT v;
            PROPERTYKEY k = _angleKey;
            rep.GetSensorValue(ref k, out v);
            double angle = Value(v);
            if (_baseFound == 7) {
                try {
                    double[] b = new double[3];
                    for (int i = 0; i < 3; i++) {
                        PROPERTYKEY bk = _baseKeys[i];
                        rep.GetSensorValue(ref bk, out v);
                        b[i] = Value(v);
                    }
                    bx = b[0]; by = b[1]; bz = b[2];
                    haveBase = !double.IsNaN(bx) && !double.IsNaN(by) && !double.IsNaN(bz);
                } catch { haveBase = false; }
            }
            return double.IsNaN(angle) ? -1 : angle;
        } catch {
            return -1;
        }
    }
}
