import {execSync} from 'node:child_process';
import {readFileSync, readdirSync} from 'node:fs';

// Refuses to run battery-sensitive e2e tests when the host is on
// battery power. Windows adaptive power throttling cuts GPU clocks
// enough to push every 60-second smoothness arm past its
// gapsOverVsync budget (locally measured 110-154 across three
// back-to-back runs vs the < 100 budget); the resulting failures
// look like real regressions but are pure power-state artefacts.
// The guard exists so a forgotten power cable does not cost a
// debugging session.
//
// ALLOW_BATTERY=1 is the documented escape hatch for cases where
// the run is wanted anyway (smoke checks, bring-up validation).
// Filtered runs that exclude battery-sensitive arms entirely use
// `playwright test --grep-invert "@battery-sensitive"` instead.

function isOnAcPower(): boolean {
    if (process.platform === 'win32') {
        return windowsIsOnAc();
    }
    if (process.platform === 'darwin') {
        return macIsOnAc();
    }
    if (process.platform === 'linux') {
        return linuxIsOnAc();
    }
    // Unknown platform: don't block. The guard is opt-in protection
    // for known environments; an unrecognised host gets a pass
    // rather than a false refusal we'd have no way to override
    // platform-by-platform.
    return true;
}

function windowsIsOnAc(): boolean {
    // Win32_Battery.BatteryStatus per Microsoft's CIM/WMI docs:
    //   1  = "The battery is discharging." (= on battery)
    //   2  = "The system has access to AC."
    //   3..11 = various charging / charged states (all imply AC).
    // Desktops with no battery yield no instance, which we treat
    // as on AC (no battery to drain).
    const script = '$b = Get-CimInstance Win32_Battery; if ($null -eq $b) { Write-Output \'AC\' } else { Write-Output $b.BatteryStatus }';
    let out: string;
    try {
        out = execSync(`pwsh -NoProfile -Command "${script}"`, {encoding: 'utf8'}).trim();
    } catch {
        // WMI query failed (access denied, powershell unavailable, etc.) — don't block.
        return true;
    }
    // 'AC' is a synthetic sentinel emitted by the script above when no battery
    // instance exists; it is not a real BatteryStatus value from the WMI schema.
    if (out === 'AC' || out === '') {
        return true;
    }

    return Number.parseInt(out, 10) !== 1;
}

function macIsOnAc(): boolean {
    let out: string;
    try {
        out = execSync('pmset -g batt', {encoding: 'utf8'});
    } catch {
        // pmset unavailable (unusual macOS environment) — don't block.
        return true;
    }

    return /'AC Power'/i.test(out);
}

function linuxIsOnAc(): boolean {
    // /sys/class/power_supply/<adapter>/online: 1 = AC, 0 = battery.
    // Adapter naming varies by hardware (AC, AC0, ACAD, ADP1...).
    // No power-supply tree (desktop, container, headless box) and no
    // matching adapter both fall through to the "treat as AC" default.
    const psRoot = '/sys/class/power_supply';
    let entries: string[];
    try {
        entries = readdirSync(psRoot);
    } catch {
        return true;
    }
    for (const entry of entries) {
        if (!/^(AC|ACAD|ADP)/i.test(entry)) {
            continue;
        }
        try {
            return readFileSync(`${psRoot}/${entry}/online`, 'utf8').trim() === '1';
        } catch {
            continue;
        }
    }

    return true;
}

export function assertOnAcPower(): void {
    if (process.env.ALLOW_BATTERY === '1') {
        return;
    }
    if (isOnAcPower()) {
        return;
    }
    throw new Error(
        [
            'E2E test refused to run: host is on battery power.',
            '',
            'Battery throttling deforms the timings these tests assert against;',
            'a failure on battery does not reliably indicate a real regression.',
            '',
            'Options:',
            '  - Plug in to AC and re-run.',
            '  - Skip battery-sensitive arms (others stay green):',
            '      pnpm --dir web exec playwright test --grep-invert "@battery-sensitive"',
            '  - Override the guard (numbers will not be trustworthy):',
            '      ALLOW_BATTERY=1 pnpm --dir web test:e2e',
        ].join('\n'),
    );
}
