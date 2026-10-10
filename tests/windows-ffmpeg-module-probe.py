"""Read-only module/patch observation for a bounded smoke process tree."""
import ctypes as C
from ctypes import wintypes as W
import hashlib
import json
from pathlib import Path
import sys


def observe(root_pid, expected_library):
    kernel = C.WinDLL('kernel32', use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [W.DWORD, W.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = W.HANDLE
    kernel.CloseHandle.argtypes = [W.HANDLE]
    kernel.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
    kernel.OpenProcess.restype = W.HANDLE
    kernel.ReadProcessMemory.argtypes = [W.HANDLE, C.c_void_p, C.c_void_p, C.c_size_t, C.POINTER(C.c_size_t)]
    kernel.ReadProcessMemory.restype = W.BOOL

    class Process(C.Structure):
        _fields_ = [('size', W.DWORD), ('usage', W.DWORD), ('pid', W.DWORD),
                    ('heap', C.c_size_t), ('module', W.DWORD), ('threads', W.DWORD),
                    ('parent', W.DWORD), ('priority', W.LONG), ('flags', W.DWORD),
                    ('exe', W.WCHAR * 260)]

    class Module(C.Structure):
        _fields_ = [('size', W.DWORD), ('id', W.DWORD), ('pid', W.DWORD),
                    ('global_usage', W.DWORD), ('process_usage', W.DWORD),
                    ('base', C.c_void_p), ('bytes', W.DWORD), ('handle', W.HMODULE),
                    ('name', W.WCHAR * 256), ('path', W.WCHAR * 260)]

    def entries(flags, pid, structure, prefix):
        first, following = getattr(kernel, prefix + 'FirstW'), getattr(kernel, prefix + 'NextW')
        for function in (first, following):
            function.argtypes = [W.HANDLE, C.POINTER(structure)]
            function.restype = W.BOOL
        snapshot = kernel.CreateToolhelp32Snapshot(flags, pid)
        if snapshot == C.c_void_p(-1).value:
            return [], C.get_last_error()
        result = []
        try:
            entry = structure()
            entry.size = C.sizeof(entry)
            valid = first(snapshot, C.byref(entry))
            while valid:
                result.append(structure.from_buffer_copy(entry))
                valid = following(snapshot, C.byref(entry))
        finally:
            kernel.CloseHandle(snapshot)
        return result, None

    processes, error = entries(2, 0, Process, 'Process32')
    if error:
        raise OSError(error, 'Cannot enumerate smoke descendants')
    selected = {root_pid}
    while True:
        following = selected | {p.pid for p in processes if p.parent in selected}
        if following == selected:
            break
        selected = following
    modules, errors = [], []
    expected = expected_library.resolve(strict=True)
    file_bytes = expected.read_bytes()
    for pid in sorted(selected):
        rows, error = entries(8 | 16, pid, Module, 'Module32')
        if error:
            errors.append({'pid': pid, 'snapshotError': error})
            continue
        for row in rows:
            if row.name.lower() != 'ffmpeg.dll':
                continue
            actual = Path(row.path).resolve(strict=True)
            if actual != expected:
                raise RuntimeError('A smoke process loaded FFmpeg from an unexpected location')
            handle = kernel.OpenProcess(0x0400 | 0x0010, False, pid)
            if not handle:
                raise C.WinError(C.get_last_error())
            try:
                patch = C.create_string_buffer(6)
                read = C.c_size_t()
                if not kernel.ReadProcessMemory(handle, row.base + 0x9b304, patch, 6, C.byref(read)):
                    raise C.WinError(C.get_last_error())
                if read.value != 6:
                    raise RuntimeError('Incomplete FFmpeg code read')
                modules.append({'pid': pid, 'module': str(actual), 'base': hex(row.base),
                                'patchRva': '0x9b304', 'patchHex': patch.raw.hex(),
                                'codeMatchesFile': patch.raw == file_bytes[632580:632586]})
            finally:
                kernel.CloseHandle(handle)
    return {'ok': bool(modules) and all(r['codeMatchesFile'] for r in modules),
            'rootPid': root_pid, 'processTree': sorted(selected), 'modules': modules,
            'exitedOrInaccessibleProcessSnapshots': errors,
            'librarySha256': hashlib.sha256(file_bytes).hexdigest(),
            'readOnly': True, 'remoteCodeExecuted': False}


if __name__ == '__main__':
    if sys.platform != 'win32' or len(sys.argv) != 3:
        raise SystemExit('Usage on Windows: python windows-ffmpeg-module-probe.py PID LIBRARY')
    result = observe(int(sys.argv[1]), Path(sys.argv[2]))
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['ok'] else 1)
