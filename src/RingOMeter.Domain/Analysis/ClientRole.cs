namespace RingOMeter.Domain.Analysis;

// slice 1: consumed by the SignalR hub's Join method; TS mirror will be
// added to web/src/wire/frames.ts at that point. Keep enum values stable.
public enum ClientRole
{
    Singer = 0,
    Display = 1,
}
