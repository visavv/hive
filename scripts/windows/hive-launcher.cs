// hive.exe: double-click (or pin) to open hive. Built by scripts/install-windows.ps1 with the C#
// compiler that ships with Windows (.NET Framework 4), with the pixel-art icon from assets/hive.ico.
//
// It runs `node dist\cli\index.js [args]` from the hive folder it sits in, without a console window.
// With no arguments that opens the folder you started it in if it looks like a project, else the last
// project you opened, else a folder picker (see openUi / pickProject in the CLI).
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Windows.Forms;

static class HiveLauncher
{
    [STAThread]
    static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string cli = Path.Combine(root, "dist", "cli", "index.js");
        if (!File.Exists(cli))
        {
            MessageBox.Show("hive isn't built yet.\n\nRun scripts\\install-windows.ps1 in " + root, "hive", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
        string node = Environment.GetEnvironmentVariable("HIVE_NODE");
        if (string.IsNullOrEmpty(node)) node = "node.exe";
        var psi = new ProcessStartInfo
        {
            FileName = node,
            Arguments = "\"" + cli + "\"" + string.Concat(args.Select(a => " " + Quote(a))),
            WorkingDirectory = Environment.CurrentDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
        };
        try
        {
            using (var p = Process.Start(psi))
            {
                string err = p.StandardError.ReadToEnd();
                p.WaitForExit();
                if (p.ExitCode != 0)
                {
                    MessageBox.Show("hive couldn't start:\n\n" + (err.Length > 1500 ? err.Substring(0, 1500) : err), "hive", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return p.ExitCode;
                }
            }
        }
        catch (Exception e)
        {
            MessageBox.Show("hive needs Node.js (" + node + "): " + e.Message + "\n\nInstall Node.js 22 LTS from https://nodejs.org", "hive", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        return 0;
    }

    // Windows command-line quoting for one argument.
    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        var sb = new System.Text.StringBuilder("\"");
        int slashes = 0;
        foreach (char c in a)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') sb.Append('\\', slashes * 2 + 1);
            else sb.Append('\\', slashes);
            slashes = 0;
            sb.Append(c);
        }
        sb.Append('\\', slashes * 2).Append('"');
        return sb.ToString();
    }
}
