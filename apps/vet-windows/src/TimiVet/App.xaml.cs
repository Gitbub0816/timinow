using System.Windows;
using TimiVet.Services;
using TimiVet.ViewModels;
using TimiVet.Views;

namespace TimiVet;

public partial class App : System.Windows.Application
{
    private MainViewModel? _viewModel;
    private AlertService? _alerts;
    private MainWindow? _main;
    private MiniWindow? _mini;
    public bool IsExiting { get; private set; }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        var store = new SettingsStore();
        _viewModel = new MainViewModel(store);
        _alerts = new AlertService(_viewModel.Settings);
        _main = new MainWindow(_viewModel);
        _mini = new MiniWindow(_viewModel) { Topmost = _viewModel.Settings.MiniWindowTopmost };
        _viewModel.NewRequestArrived += (_, request) => _alerts.NewRequest(request);
        _alerts.ShowMainRequested += (_, _) => ShowMain();
        _alerts.ShowMiniRequested += (_, _) => ShowMini();
        _alerts.ExitRequested += (_, _) => ExitApplication();
        _main.Show();
        _ = _viewModel.StartAsync();
    }

    public void ShowMain()
    {
        if (_main is null) return;
        if (_main.WindowState == WindowState.Minimized) _main.WindowState = WindowState.Normal;
        _main.Show(); _main.Activate();
    }

    public void ShowMini()
    {
        if (_mini is null) return;
        if (_mini.WindowState == WindowState.Minimized) _mini.WindowState = WindowState.Normal;
        _mini.Topmost = _viewModel?.Settings.MiniWindowTopmost ?? true;
        _mini.Show(); _mini.Activate();
    }

    public void ExitApplication()
    {
        IsExiting = true;
        _mini?.Close(); _main?.Close(); Shutdown();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _viewModel?.Dispose(); _alerts?.Dispose(); base.OnExit(e);
    }
}
