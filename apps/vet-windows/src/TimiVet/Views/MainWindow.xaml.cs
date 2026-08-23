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
    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (((App)System.Windows.Application.Current).IsExiting) return;
        e.Cancel = true;
        Hide();
    }
}
