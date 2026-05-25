// web/src/lab/ui/CoefficientDashboard.tsx
// Band 3: read-only view of computeCalibration output. All twelve axes grouped
// fitted -> needs-attention -> untouched; fitted axes get a sigmoid sparkline + a
// CI-relative-to-zero bar; below-floor axes show n / N_FLOOR progress. The parent
// runs computeCalibration on demand and passes results down (spec "### Band 3").

import type {CSSProperties} from 'react';
import {N_FLOOR, type CoefficientResult} from '../fit/coefficients';
import {ciBarGeometry, groupByBucket, sigmoidSparklinePath} from './coefficientView';

export interface CoefficientDashboardProps {
    coefficients: Map<string, CoefficientResult>;
    skippedMalformedCount: number;
    onRefresh: () => void;
}

const bandStyle: CSSProperties = {padding: 16, background: '#202020', borderRadius: 8, marginBottom: 16};
const rowStyle: CSSProperties = {display: 'flex', gap: 12, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #333'};

const BUCKET_LABEL: Record<string, string> = {fitted: 'Fitted', 'needs-attention': 'Needs attention', untouched: 'Untouched'};

const SPARK_W = 80;
const SPARK_H = 24;
const CI_W = 120;
const CI_SCALE = 1; // slope-units spanning the CI bar half-width

function isFitted(r: CoefficientResult): r is Extract<CoefficientResult, {slope: number}> {
    return r.status === 'ok' || r.status === 'saturated' || r.status === 'no-effect';
}

export function CoefficientDashboard(props: CoefficientDashboardProps) {
    const groups = groupByBucket(props.coefficients);

    return (
        <div style={bandStyle} data-testid="dashboard">
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                <h2>Coefficients</h2>
                <button type="button" data-testid="refresh" onClick={props.onRefresh}>Refresh</button>
            </div>
            {props.skippedMalformedCount > 0 && (
                <p style={{color: '#e0a030'}} data-testid="skipped-count">{props.skippedMalformedCount} malformed row(s) skipped</p>
            )}
            {groups.map((group) => (
                <section key={group.bucket}>
                    <h3>{BUCKET_LABEL[group.bucket]}</h3>
                    {group.rows.map(({axis, result}) => (
                        <div key={axis} style={rowStyle} data-axis={axis} data-status={result.status}>
                            <span style={{width: 160}}>{axis}</span>
                            <span style={{width: 130}}>{result.status}</span>
                            <span style={{width: 80}}>
                                {result.status === 'insufficient-data' ? `${result.n} / ${N_FLOOR}` : `n=${result.n}`}
                            </span>
                            {isFitted(result) && (
                                <>
                                    <svg width={SPARK_W} height={SPARK_H} data-testid={`spark-${axis}`}>
                                        <path d={sigmoidSparklinePath(result.slope, result.intercept, [-20, 20], SPARK_W, SPARK_H)} fill="none" stroke="#5cf" strokeWidth={1.5} strokeDasharray={result.status === 'saturated' ? '3,2' : undefined} />
                                    </svg>
                                    {(() => {
                                        const g = ciBarGeometry(result.ci95, CI_SCALE, CI_W);

                                        return (
                                            <svg width={CI_W} height={12} data-testid={`ci-${axis}`}>
                                                <line x1={g.zeroX} y1={0} x2={g.zeroX} y2={12} stroke="#666" />
                                                <rect x={g.x} y={3} width={g.width} height={6} fill={g.crossesZero ? '#888' : '#5f9'} />
                                            </svg>
                                        );
                                    })()}
                                </>
                            )}
                        </div>
                    ))}
                </section>
            ))}
        </div>
    );
}
