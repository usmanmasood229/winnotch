# Streams the laptop hinge angle (degrees) to stdout, one value per line.
#
# The angle comes from the "Hinge Sensor" exposed by the Win32 COM Sensor API.
# It is NOT reachable through WinRT (Windows.Devices.Sensors.HingeAngleSensor):
# Lenovo registers it as a *custom* sensor type, and WinRT only projects the
# sensor types it knows about, so it reports no device at all.
#
# NOTE: PROPVARIANT must be 24 bytes on x64. Sizing it any smaller makes every
# GetSensorValue call fail with ERROR_NOT_FOUND on every sensor, which looks
# exactly like "this machine has no sensor data".

$src = @"
using System;
using System.Runtime.InteropServices;

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
    const uint ANGLE_PID = 7;
    static ISensor _sensor;
    static PROPERTYKEY _angleKey;
    static bool _haveKey;

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
            for (uint f = 0; f < fc; f++) {
                PROPERTYKEY k;
                fields.GetAt(f, out k);
                if (k.pid == ANGLE_PID) { _angleKey = k; _haveKey = true; break; }
            }
            if (_haveKey) { _sensor = s; return true; }
        }
        return false;
    }

    // Returns the hinge angle in degrees, or -1 when unreadable.
    public static double Read() {
        try {
            ISensorDataReport rep;
            _sensor.GetData(out rep);
            PROPVARIANT v;
            PROPERTYKEY k = _angleKey;
            rep.GetSensorValue(ref k, out v);
            switch (v.vt) {
                case 2:  return v.iVal;
                case 3:  return v.lVal;
                case 4:  return v.fltVal;
                case 5:  return v.dblVal;
                case 19: return v.ulVal;
                default: return -1;
            }
        } catch {
            return -1;
        }
    }
}
"@

try {
    Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop
} catch {
    [Console]::Error.WriteLine("HINGE_ERR compile: " + $_.Exception.Message)
    exit 1
}

try {
    if (-not [HingeReader]::Init()) {
        [Console]::Error.WriteLine("HINGE_ERR no hinge sensor on this machine")
        exit 2
    }
} catch {
    [Console]::Error.WriteLine("HINGE_ERR init: " + $_.Exception.Message)
    exit 3
}

# Emit only on change so the parent process isn't woken for identical values.
# Fractional degrees are kept (when the sensor has them) — truncating to whole
# degrees turned smooth lid travel into a staircase. Invariant culture so a
# locale with a decimal comma can't break parsing on the other side.
$inv  = [Globalization.CultureInfo]::InvariantCulture
$last = [double]::NaN
while ($true) {
    $a = [math]::Round([HingeReader]::Read(), 1)
    if ($a -ge 0 -and $a -ne $last) {
        $last = $a
        [Console]::Out.WriteLine($a.ToString($inv))
        [Console]::Out.Flush()
    }
    Start-Sleep -Milliseconds 33
}
