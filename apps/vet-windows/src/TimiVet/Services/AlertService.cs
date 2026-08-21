using System.Drawing;
using System.Media;
using Forms = System.Windows.Forms;
using TimiVet.Models;

namespace TimiVet.Services;

public sealed class AlertService : IDisposable
{
    private readonly Forms.NotifyIcon _tray;
    private readonly AppSettings _settings;
    public event EventHandler? ShowMainRequested;
    public event EventHandler? ShowMiniRequested;
    public event EventHandler? ExitRequested;

    public AlertService(AppSettings settings)
    {
        _settings = settings;
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Open Tími Vet", null, (_, _) => ShowMainRequested?.Invoke(this, EventArgs.Empty));
        menu.Items.Add("Open floating console", null, (_, _) => ShowMiniRequested?.Invoke(this, EventArgs.Empty));
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitRequested?.Invoke(this, EventArgs.Empty));
        _tray = new Forms.NotifyIcon { Icon = SystemIcons.Information, Text = "Tími Vet", Visible = true, ContextMenuStrip = menu };
        _tray.DoubleClick += (_, _) => ShowMainRequested?.Invoke(this, EventArgs.Empty);
        _tray.BalloonTipClicked += (_, _) => ShowMainRequested?.Invoke(this, EventArgs.Empty);
    }

    public void NewRequest(ClinicRequest request)
    {
        if (!_settings.AlertsEnabled) return;
        if (_settings.PlaySound) SystemSounds.Exclamation.Play();
        _tray.BalloonTipTitle = request.IsEmergency ? $"Emergency intake · {request.Pet.Name}" : $"New intake · {request.Pet.Name}";
        _tray.BalloonTipText = request.ConcernSummary.Length > 180 ? request.ConcernSummary[..177] + "…" : request.ConcernSummary;
        _tray.BalloonTipIcon = request.IsEmergency ? Forms.ToolTipIcon.Warning : Forms.ToolTipIcon.Info;
        _tray.ShowBalloonTip(7000);
    }

    public void Dispose() { _tray.Visible = false; _tray.Dispose(); }
}
