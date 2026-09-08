using System.ComponentModel;
using System.Windows;
using TimiVet.ViewModels;

namespace TimiVet.Views;

public partial class MainWindow : Window
{
    private readonly MainViewModel _viewModel;
    public MainWindow(MainViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = viewModel;
        Closing += OnClosing;
        _viewModel.OpenPeopleRequested += (_, _) => ((App)System.Windows.Application.Current).ShowPeople();
        this.FitToWorkArea();
    }

    private void OpenMini_Click(object sender, RoutedEventArgs e) => ((App)System.Windows.Application.Current).ShowMini();

    /// <summary>
    /// The left rail's "Live intake" nav item. This console is one continuously-scrolling page rather than
    /// the mockup's page-per-destination shell, so a nav item scrolls to its section instead of switching a
    /// visible view — the request workspace already sits at the top of the page, so this is simply "back to
    /// the top".
    /// </summary>
    private void NavOperations_Click(object sender, RoutedEventArgs e) => WorkspaceScroll.ScrollToTop();

    /// <summary>The left rail's "Clinic settings" nav item: opens the settings Expander (it starts
    /// collapsed) and brings it on screen, rather than navigating to a separate settings page.</summary>
    private void NavSettings_Click(object sender, RoutedEventArgs e)
    {
        SettingsExpander.IsExpanded = true;
        SettingsExpander.BringIntoView();
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (((App)System.Windows.Application.Current).IsExiting) return;
        e.Cancel = true;
        Hide();
    }
}
