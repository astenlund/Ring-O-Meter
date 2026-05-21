export type RingIndicatorState = 'green' | 'yellow' | 'red' | null;

const STATE_COLORS: Record<'green' | 'yellow' | 'red', string> = {
    green: '#4ade80',
    yellow: '#fbbf24',
    red: '#ef4444',
};

const DOT_SIZE = 16;

export interface RingIndicatorDotProps {
    state: RingIndicatorState;
}

export function RingIndicatorDot({state}: RingIndicatorDotProps) {
    if (state === null) {
        return null;
    }

    return (
        <span
            aria-label={`ring-${state}`}
            style={{
                display: 'inline-block',
                width: DOT_SIZE,
                height: DOT_SIZE,
                borderRadius: '50%',
                backgroundColor: STATE_COLORS[state],
            }}
        />
    );
}
