namespace RingOMeter.Domain.Analysis;

// Mirror: web/src/wire/frames.ts ClientRole. Keep enum values in sync.
// Currently unused in slice 0 (no server); wired up in slice 1 alongside
// the SignalR hub's Join method.
public enum ClientRole
{
    Singer = 0,
    Display = 1,
}
