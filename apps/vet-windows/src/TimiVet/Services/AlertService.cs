using System.Drawing;
using System.IO;
using System.Media;
using System.Text;
using Forms = System.Windows.Forms;
using TimiVet.Models;

namespace TimiVet.Services;

public sealed class AlertService : IDisposable
{
    private readonly Forms.NotifyIcon _tray;
    private readonly AppSettings _settings;

    /// <summary>
    /// The player is held for as long as the sound might still be playing. <see cref="SoundPlayer.Play"/>
    /// hands the audio to Windows and returns immediately; a player that goes out of scope and is
    /// finalized mid-sound simply stops, which is its own flavour of the silent-alert bug.
    /// </summary>
    private SoundPlayer? _alertPlayer;

    public event EventHandler? ShowMainRequested;
    public event EventHandler? ShowMiniRequested;
    public event EventHandler? OpenPeopleRequested;
    public event EventHandler? ExitRequested;

    public AlertService(AppSettings settings)
    {
        _settings = settings;
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Open Tími Vet", null, (_, _) => ShowMainRequested?.Invoke(this, EventArgs.Empty));
        menu.Items.Add("Open floating console", null, (_, _) => ShowMiniRequested?.Invoke(this, EventArgs.Empty));
        menu.Items.Add("Manage people", null, (_, _) => OpenPeopleRequested?.Invoke(this, EventArgs.Empty));
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitRequested?.Invoke(this, EventArgs.Empty));
        _tray = new Forms.NotifyIcon { Icon = SystemIcons.Information, Text = "Tími Vet", Visible = true, ContextMenuStrip = menu };
        _tray.DoubleClick += (_, _) => ShowMainRequested?.Invoke(this, EventArgs.Empty);
        _tray.BalloonTipClicked += (_, _) => ShowMainRequested?.Invoke(this, EventArgs.Empty);
    }

    public void NewRequest(ClinicRequest request)
    {
        if (!_settings.AlertsEnabled) return;
        if (_settings.PlaySound) PlayAlert(request.IsEmergency);
        _tray.BalloonTipTitle = request.IsEmergency ? $"Emergency intake · {request.Pet.Name}" : $"New intake · {request.Pet.Name}";
        _tray.BalloonTipText = request.ConcernSummary.Length > 180 ? request.ConcernSummary[..177] + "…" : request.ConcernSummary;
        _tray.BalloonTipIcon = request.IsEmergency ? Forms.ToolTipIcon.Warning : Forms.ToolTipIcon.Info;
        _tray.ShowBalloonTip(7000);
    }

    /// <summary>
    /// Plays the alert on demand, for the Test button in Settings. "No sound fires" is not something
    /// anybody should have to wait for a real patient in order to find out.
    /// </summary>
    public void PreviewAlert() => PlayAlert(emergency: false);

    /// <summary>
    /// A sound that actually plays.
    ///
    /// This used to be <c>SystemSounds.Exclamation.Play()</c>, and there are two independent reasons
    /// nobody ever heard it. That call is <c>PlaySound</c> with a system alias, which routes to the
    /// "System sounds" channel in the Volume Mixer — a slider separate from output volume, muted outright
    /// by the "No Sounds" scheme that most managed clinic images ship with. And the balloon's own sound is
    /// suppressed by Windows whenever the notification is silenced by Focus Assist or the app raising it
    /// is already in the foreground, which is exactly when somebody is watching the queue.
    ///
    /// Playing real audio data instead puts the sound in this process's own audio session, where it
    /// follows the app's volume like any other program and plays whether or not the console has focus.
    /// </summary>
    private void PlayAlert(bool emergency)
    {
        try
        {
            var player = CreatePlayer(emergency);
            if (player is null) return;
            _alertPlayer?.Stop();
            _alertPlayer?.Dispose();
            _alertPlayer = player;
            player.Play();
        }
        catch
        {
            // A machine with no audio device at all is a real configuration in a back office. It is not
            // worth an error dialog over the top of an incoming patient.
        }
    }

    private static SoundPlayer? CreatePlayer(bool emergency)
    {
        foreach (var candidate in CandidateFiles(emergency))
        {
            try
            {
                if (!File.Exists(candidate)) continue;
                var player = new SoundPlayer(candidate);
                // Load eagerly: Play() on an unloaded player reads the file on the playback thread and
                // fails silently if it cannot, which is indistinguishable from a muted machine.
                player.Load();
                return player;
            }
            catch
            {
                // Try the next one. A stock sound can be missing on a stripped Windows image.
            }
        }

        try
        {
            var player = new SoundPlayer(new MemoryStream(Chime(emergency)));
            player.Load();
            return player;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Stock Windows sounds, chosen for what they have to convey rather than for being pleasant: the
    /// emergency pair is insistent and repeats, the ordinary one is a single note that a busy front desk
    /// can live with all day. Every one of these is an ordinary WAV file, not a system alias.
    /// </summary>
    private static IEnumerable<string> CandidateFiles(bool emergency)
    {
        var media = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Media");
        // Written as explicit arrays rather than collection expressions: two collection expressions in the
        // arms of a conditional leave it with no natural type to infer from.
        var names = emergency
            ? new[] { "Alarm01.wav", "Windows Notify Calendar.wav", "Windows Exclamation.wav", "Windows Notify.wav" }
            : new[] { "Windows Notify Messaging.wav", "Windows Notify.wav", "Windows Ding.wav", "notify.wav" };
        foreach (var name in names) yield return Path.Combine(media, name);
    }

    /// <summary>
    /// A two-note chime synthesised in memory, for a Windows install whose Media folder has been stripped
    /// — which happens on hardened images, and would otherwise leave the console silent with no way to
    /// tell. Sixteen-bit mono PCM, raised-cosine envelope so the notes do not click.
    /// </summary>
    private static byte[] Chime(bool emergency)
    {
        const int sampleRate = 22050;
        // (hertz, seconds). Deconstructed positionally below, so the elements carry no names — a named
        // element in one arm of the conditional and an unnamed one in the other only invites a warning
        // about the name being dropped.
        var notes = emergency
            ? new[] { (988.0, 0.14), (1319.0, 0.14), (988.0, 0.14), (1319.0, 0.22) }
            : new[] { (784.0, 0.16), (1047.0, 0.30) };

        var samples = new List<short>();
        foreach (var (frequency, seconds) in notes)
        {
            var count = Math.Max(2, (int)(sampleRate * seconds));
            for (var index = 0; index < count; index++)
            {
                var envelope = 0.5 - 0.5 * Math.Cos(2 * Math.PI * index / (count - 1));
                var value = Math.Sin(2 * Math.PI * frequency * index / sampleRate) * envelope * 0.55;
                samples.Add((short)(value * short.MaxValue));
            }
        }

        var dataBytes = samples.Count * 2;
        using var stream = new MemoryStream(44 + dataBytes);
        using (var writer = new BinaryWriter(stream, Encoding.ASCII, leaveOpen: true))
        {
            writer.Write(Encoding.ASCII.GetBytes("RIFF"));
            writer.Write(36 + dataBytes);
            writer.Write(Encoding.ASCII.GetBytes("WAVE"));
            writer.Write(Encoding.ASCII.GetBytes("fmt "));
            writer.Write(16);                 // PCM format chunk length
            writer.Write((short)1);           // PCM, uncompressed
            writer.Write((short)1);           // mono
            writer.Write(sampleRate);
            writer.Write(sampleRate * 2);     // bytes per second
            writer.Write((short)2);           // block align
            writer.Write((short)16);          // bits per sample
            writer.Write(Encoding.ASCII.GetBytes("data"));
            writer.Write(dataBytes);
            foreach (var sample in samples) writer.Write(sample);
        }
        return stream.ToArray();
    }

    public void Dispose()
    {
        _alertPlayer?.Dispose();
        _tray.Visible = false;
        _tray.Dispose();
    }
}
