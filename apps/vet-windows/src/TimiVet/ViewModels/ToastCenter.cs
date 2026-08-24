using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Windows.Threading;

namespace TimiVet.ViewModels;

public enum ToastKind { Success, Failure, Working }

/// <summary>
/// One short-lived confirmation.
/// </summary>
public sealed class Toast : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    public Toast(string message, ToastKind kind) { Message = message; Kind = kind; }

    public string Message { get; }
    public ToastKind Kind { get; }
    public bool IsSuccess => Kind == ToastKind.Success;
    public bool IsFailure => Kind == ToastKind.Failure;
}

/// <summary>
/// Says whether the thing you just pressed worked.
/// </summary>
/// <remarks>
/// Every action in this console wrote its outcome into StatusMessage, a line of
/// small grey text in a panel at the top of the window. Pressing "Send
/// availability offer" at the bottom of the decision workspace therefore
/// produced no visible change anywhere near the pointer — the confirmation was
/// several hundred pixels away, in the same grey as the text that was already
/// there, and it replaced the previous message rather than appearing. From a
/// front desk that is indistinguishable from a button that does nothing, and
/// the honest response to a button that does nothing is to press it again.
///
/// A toast appears where the eye already is, says what happened in the colour
/// that means it, and leaves. Failures stay longer than successes because
/// "sent" needs a glance and "could not send" needs reading.
/// </remarks>
public sealed class ToastCenter
{
    private readonly Dispatcher _dispatcher;

    public ToastCenter(Dispatcher dispatcher) { _dispatcher = dispatcher; }

    public ObservableCollection<Toast> Toasts { get; } = [];

    public void Success(string message) => Show(new Toast(message, ToastKind.Success), TimeSpan.FromSeconds(3));
    public void Failure(string message) => Show(new Toast(message, ToastKind.Failure), TimeSpan.FromSeconds(7));

    private void Show(Toast toast, TimeSpan life)
    {
        if (!_dispatcher.CheckAccess()) { _dispatcher.Invoke(() => Show(toast, life)); return; }

        // Three is the most that can be read before the first one goes. Beyond
        // that they stop being confirmations and become a log.
        Toasts.Insert(0, toast);
        while (Toasts.Count > 3) Toasts.RemoveAt(Toasts.Count - 1);

        var timer = new DispatcherTimer(DispatcherPriority.Normal, _dispatcher) { Interval = life };
        timer.Tick += (_, _) => { timer.Stop(); Toasts.Remove(toast); };
        timer.Start();
    }
}
