using System.Windows;
using TimiVet.ViewModels;

namespace TimiVet.Views;

public partial class PeopleWindow : Window
{
    private readonly PeopleViewModel _viewModel;

    public PeopleWindow(PeopleViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = viewModel;
        this.FitToWorkArea();
    }

    private void Window_Loaded(object sender, RoutedEventArgs e) => _viewModel.LoadCommand.Execute(null);
}
