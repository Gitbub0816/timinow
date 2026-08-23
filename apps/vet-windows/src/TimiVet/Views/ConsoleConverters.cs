using System.Globalization;
using System.Windows;
using System.Windows.Data;
using System.Windows.Media;

namespace TimiVet.Views;

/// <summary>
/// Converters for the operations console. Each one exists because the alternative was a property on the
/// view model that only a single piece of XAML could ever want.
/// </summary>
public sealed class NullToVisibilityConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture)
        => value is null ? Visibility.Collapsed : Visibility.Visible;
    public object ConvertBack(object? value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}

public sealed class NullToInverseVisibilityConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture)
        => value is null ? Visibility.Visible : Visibility.Collapsed;
    public object ConvertBack(object? value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}

/// <summary>
/// Shows the accept/decline pair only on a request that is still waiting for an answer.
///
/// A row that has already been accepted keeps its place in the queue for the rest of the shift, and
/// offering "Yes, we can see them" on it invites a second decision that the Worker would refuse — after
/// the press, with an error, which reads as the console being broken rather than as the request being
/// finished.
/// </summary>
public sealed class PendingStatusToVisibilityConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture)
        => string.Equals(value as string, "pending", StringComparison.OrdinalIgnoreCase) ? Visibility.Visible : Visibility.Collapsed;
    public object ConvertBack(object? value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}

/// <summary>
/// The connection badge's colour. Gold while the console is genuinely current, coral the moment it is not
/// — a stale queue that looks live is the failure this is here to make impossible.
///
/// The two brushes are looked up from Theme.xaml rather than written out here, so the palette stays in
/// one file. Types are spelled out in full because this project enables WPF and WinForms together — only
/// the tray icon needs WinForms — and both bring a <c>Color</c> and an <c>Application</c> into scope.
/// </summary>
public sealed class ConnectionHealthToBrushConverter : IValueConverter
{
    // Frozen: an unfrozen Freezable belongs to the thread that made it, and a static field is made on
    // whichever thread happens to touch this class first.
    private static readonly SolidColorBrush HealthyFallback = Frozen(0xF7, 0xC8, 0x4B);
    private static readonly SolidColorBrush TroubleFallback = Frozen(0xF2, 0x5F, 0x4C);

    private static SolidColorBrush Frozen(byte red, byte green, byte blue)
    {
        var brush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(red, green, blue));
        brush.Freeze();
        return brush;
    }

    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture)
    {
        var healthy = value is bool flag && flag;
        var resource = System.Windows.Application.Current?.TryFindResource(healthy ? "Gold" : "Coral");
        return resource as SolidColorBrush ?? (healthy ? HealthyFallback : TroubleFallback);
    }

    public object ConvertBack(object? value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}

/// <summary>
/// Two letters for the avatar tile. This used to be the whole pet name trimmed to 28 device-independent
/// pixels inside a 38-pixel circle, so "Juniper" rendered as "Jun…" hard against both edges.
/// </summary>
public sealed class InitialsConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object parameter, CultureInfo culture)
    {
        var name = (value as string)?.Trim() ?? "";
        if (name.Length == 0) return "?";
        return name.Length <= 2 ? name.ToUpperInvariant() : name[..2].ToUpperInvariant();
    }

    public object ConvertBack(object? value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}
