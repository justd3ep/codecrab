/**
 * stackProfile.ts — Derive the requested frontend stack + hard constraints
 * from the user's natural-language request.
 *
 * WHY THIS EXISTS
 * ---------------
 * The router used to hard-code a React + Vite + TypeScript + Tailwind scaffold
 * for EVERY frontend request. A request like:
 *
 *   "Build a single-file HTML/CSS/JS kanban board ... using native HTML5 drag
 *    events only (no libraries)"
 *
 * still produced a React/TypeScript/Tailwind project with vite.config.ts,
 * tailwind.config.js, src/App.tsx, src/components/*.tsx — and code that did
 * not even compile (missing imports, a component named after the wrong file).
 *
 * The stack must be derived from the request, not assumed. Precedence:
 *
 *   1. Explicit signal in the request  ("single file", "vanilla", "no react")
 *   2. Existing workspace state       (package.json already has react, .tsx on disk)
 *   3. Legacy default                 (React app — unchanged behaviour)
 *
 * The profile is consumed by three places:
 *   - frontendScaffold.ts  → decides whether to scaffold a React toolchain at all
 *   - prompts/promptBuilder.ts (and index.ts) → picks the prompt set + injects hard constraints
 *   - validator.ts          → enforces the contract after generation
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StackKind = 'react' | 'vanilla' | 'single-file' | 'framework';

export type StackFramework = 'none' | 'react' | 'vue' | 'svelte' | 'next' | 'angular' | 'unknown';

export interface StackProfile {
    /** Coarse bucket that drives scaffolding + prompt selection. */
    kind: StackKind;
    /** Concrete UI framework, 'none' for vanilla HTML. */
    framework: StackFramework;
    /** Language of the target artifact. */
    language: 'html' | 'javascript' | 'typescript';
    /** The whole deliverable must be one file. */
    singleFile: boolean;
    /** The one file that must be produced (null = not constrained). */
    targetFile: string | null;
    /** No third-party package / CDN / external script may be used. */
    noThirdPartyImports: boolean;
    /** The artifact must run without a bundler or build step. */
    noBuildStep: boolean;
    /** Packages that must never be imported for this stack. */
    forbiddenLibraries: string[];
    /**
     * Minimum context window the deliverable needs. A single-file app is one
     * large file (6–10k tokens); with the default 8k window the model gets cut
     * off mid-file, which produces truncated HTML with a syntax error.
     */
    minContextSize: number;
    /** Recommended per-response token cap for this deliverable. */
    recommendedMaxTokens: number;
    /** Ready-to-inject hard constraint lines for the system prompt. */
    constraints: string[];
    /** The original request text — the validator probes it for requirement coverage. */
    request: string;
    /** Which rules fired — for logging and debugging. */
    signals: string[];
}

// ---------------------------------------------------------------------------
// Signal regexes
// ---------------------------------------------------------------------------

/** "single file", "one file", "all in one file", "self-contained" */
const RE_SINGLE_FILE = /\b(?:single[-\s]?file|one[-\s]file|one single file|all (?:of )?(?:the )?(?:code|logic|markup|styles|javascript|css) in one file|in a single file|self[-\s]contained)\b/i;

/** Explicit "no framework" / "plain HTML" / "no build step" signals. */
const RE_VANILLA = /\b(?:vanilla|plain (?:html|javascript|js|css)|no (?:react|vue|angular|svelte|framework|build)|without (?:a )?(?:react|vue|angular|svelte|framework|build step|build tool|bundler)|no build step|html\s*\/\s*css\s*\/\s*(?:js|javascript)|html,?\s*css,?\s*(?:js|javascript)|static (?:html )?(?:page|site|app))\b/i;

/** "no libraries", "without dependencies", "no npm packages" */
const RE_NO_LIBS = /\b(?:no|without|zero|don'?t use any)\s+(?:third[-\s]?party\s+|external\s+|npm\s+)?(?:libraries|dependencies|packages|frameworks?|modules)\b/i;

/** "no CDN", "no external script" */
const RE_NO_CDN = /\bno (?:cdn|external scripts?|remote scripts?|external stylesheets?)\b/i;

/** "using native HTML5 drag events only" */
const RE_NATIVE_ONLY = /\bnative\s+([A-Za-z0-9][A-Za-z0-9\s-]{2,40}?)\s+(?:only|without|no)\b/i;

const RE_REACT = /\breact(?:\.js)?\b/i;
const RE_VUE = /\bvue(?:\.js)?\b/i;
const RE_SVELTE = /\bsvelte(?:\.kit)?\b/i;
const RE_NEXT = /\bnext\.?js\b/i;
const RE_ANGULAR = /\bangular(?:\.js)?\b/i;

const RE_TYPESCRIPT = /\btypescript\b/i;
const RE_JAVASCRIPT = /\bjavascript\b|\bjs\b/i;
const RE_HTML = /\bhtml\b/i;

/** Packages that make no sense for a plain-HTML deliverable. */
const FRAMEWORK_PACKAGES = [
    'react', 'react-dom', 'preact', 'vue', 'svelte', '@angular/core',
    'next', 'solid-js', 'alpinejs', 'stimulus', 'htmx.org',
];

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export interface StackDetectionOptions {
    /** Workspace already contains .tsx/.jsx files. */
    workspaceHasReact?: boolean;
    /** Raw package.json content of the workspace (may be empty). */
    packageJson?: string;
}

export function detectStackProfile(
    userRequest: string,
    opts: StackDetectionOptions = {},
): StackProfile {
    const msg = userRequest || '';
    const signals: string[] = [];
    const constraints: string[] = [];

    // ── Signals ──────────────────────────────────────────────────────────────
    const saysSingleFile = RE_SINGLE_FILE.test(msg);
    const saysVanilla = RE_VANILLA.test(msg);
    const saysNoReact = /\b(?:no|without|not)\s+react\b/i.test(msg);
    const saysNoLibs = RE_NO_LIBS.test(msg);
    const saysNoCdn = RE_NO_CDN.test(msg);
    const nativeMatch = msg.match(RE_NATIVE_ONLY);
    const nativePhrase = nativeMatch?.[1]?.trim() || null;

    const pkg = (opts.packageJson || '').toLowerCase();
    const workspaceReact = !!opts.workspaceHasReact
        || pkg.includes('"react"') || pkg.includes('"react-dom"');

    const wantsReact = RE_REACT.test(msg);
    const wantsVue = RE_VUE.test(msg);
    const wantsSvelte = RE_SVELTE.test(msg);
    const wantsNext = RE_NEXT.test(msg);
    const wantsAngular = RE_ANGULAR.test(msg);

    // Explicit "no framework" wins over every positive framework signal.
    const explicitlyPlain = (saysVanilla || saysNoReact) && !wantsReact;

    // ── Framework + kind ────────────────────────────────────────────────────
    let framework: StackFramework = 'none';
    let kind: StackKind = 'react';

    if (wantsReact && !explicitlyPlain) {
        framework = 'react';
        kind = 'react';
        signals.push('explicit:react');
    } else if (wantsVue) {
        framework = 'vue'; kind = 'framework'; signals.push('explicit:vue');
    } else if (wantsSvelte) {
        framework = 'svelte'; kind = 'framework'; signals.push('explicit:svelte');
    } else if (wantsNext) {
        framework = 'next'; kind = 'framework'; signals.push('explicit:next');
    } else if (wantsAngular) {
        framework = 'angular'; kind = 'framework'; signals.push('explicit:angular');
    } else if (explicitlyPlain) {
        framework = 'none';
        kind = saysSingleFile ? 'single-file' : 'vanilla';
        signals.push(saysVanilla ? 'explicit:vanilla' : 'explicit:no-react');
    } else if (workspaceReact) {
        framework = 'react'; kind = 'react';
        signals.push('workspace:react');
    } else {
        // Legacy default — unchanged behaviour for prompts that say nothing.
        framework = 'react'; kind = 'react';
        signals.push('default:react');
    }

    // A React project that is also single-file is a React single file, not HTML.
    const plainStack = kind === 'vanilla' || kind === 'single-file';

    // ── Language ────────────────────────────────────────────────────────────
    let language: StackProfile['language'];
    if (plainStack) {
        language = RE_HTML.test(msg) ? 'html' : 'javascript';
    } else {
        language = RE_TYPESCRIPT.test(msg) ? 'typescript'
            : RE_JAVASCRIPT.test(msg) ? 'javascript'
                : 'typescript';
    }
    if (saysSingleFile) signals.push('constraint:single-file');
    if (saysNoLibs) signals.push('constraint:no-libraries');
    if (saysNoCdn) signals.push('constraint:no-cdn');
    if (nativePhrase) signals.push(`constraint:native:${nativePhrase}`);

    // ── Target file ─────────────────────────────────────────────────────────
    let targetFile: string | null = null;
    if (kind === 'single-file') {
        targetFile = 'index.html';
    } else if (plainStack) {
        targetFile = 'index.html';
    } else if (saysSingleFile) {
        targetFile = language === 'javascript' ? 'src/App.jsx' : 'src/App.tsx';
    }

    // ── Import policy ───────────────────────────────────────────────────────
    const noThirdPartyImports = saysNoLibs || (plainStack && saysNoCdn);
    const noBuildStep = plainStack;

    const forbiddenLibraries = plainStack
        ? FRAMEWORK_PACKAGES.slice()
        : [];

    // ── Hard constraints for the prompt ─────────────────────────────────────
    if (kind === 'single-file') {
        const file = targetFile || 'index.html';
        constraints.push(
            `HARD CONSTRAINT — SINGLE FILE: your ENTIRE deliverable is ONE file: \`${file}\`.`,
            `Emit exactly one <file> block and nothing else.`,
            `Do NOT create package.json, tsconfig.json, vite.config.*, tailwind.config.*, postcss.config.*, a src/ folder, README, or any other file.`,
            `Put ALL markup, ALL CSS (inline <style>) and ALL JavaScript (inline <script>) inside \`${file}\`.`,
            `The file must work when opened directly in a browser (file://) — no bundler, no build step, no module imports.`,
        );
    } else if (kind === 'vanilla') {
        constraints.push(
            `HARD CONSTRAINT — VANILLA STACK: plain HTML + CSS + vanilla JavaScript only.`,
            `No React, no JSX, no TypeScript, no component framework, no build step, no bundler.`,
            `Do NOT create package.json / tsconfig.json / vite.config.* / tailwind.config.* unless the user explicitly asked for a build setup.`,
            `Ship the app as \`index.html\` (inline <style> and <script>) unless the user asked for separate files.`,
        );
    }

    if (noThirdPartyImports) {
        constraints.push(
            `HARD CONSTRAINT — NO LIBRARIES: do NOT import or load any third-party library.`,
            `No npm packages, no CDN <script src="https://cdn...">, no external <link> stylesheet, no icon fonts.`,
            `Use only browser built-ins (document, window, localStorage, drag events, fetch, timers).`,
        );
    }

    if (nativePhrase) {
        constraints.push(
            `HARD CONSTRAINT — NATIVE APIs ONLY: implement this with native browser APIs only (${nativePhrase}).`,
            `Do NOT use any library for it, and do NOT simulate it with a framework.`,
        );
    }

    if (plainStack) {
        constraints.push(
            `QUALITY BAR: every requirement in the request must be actually implemented — no TODOs, no placeholders, no "// implement this" comments.`,
            `QUALITY BAR: every event handler, DOM id and CSS class you reference must exist in the same file.`,
        );
    }

    const profile: StackProfile = {
        kind,
        framework,
        language,
        singleFile: saysSingleFile,
        targetFile,
        noThirdPartyImports,
        noBuildStep,
        forbiddenLibraries,
        // One file has to hold the whole app → give the model room for it.
        minContextSize: kind === 'single-file' ? 16384 : 8192,
        recommendedMaxTokens: kind === 'single-file' ? 10240 : 4096,
        constraints,
        signals,
        request: userRequest,
    };

    console.log(
        `[StackProfile] kind=${kind} framework=${framework} lang=${language} ` +
        `singleFile=${profile.singleFile} target=${targetFile ?? '-'} ` +
        `noLibs=${noThirdPartyImports} noBuild=${noBuildStep} signals=[${signals.join(', ')}]`,
    );

    return profile;
}

/** True when the profile describes a plain HTML/CSS/JS deliverable. */
export function isPlainStack(profile: StackProfile | undefined): boolean {
    if (!profile) return false;
    return profile.kind === 'vanilla' || profile.kind === 'single-file';
}

/** One-line human summary for logs / telemetry. */
export function describeStackProfile(profile: StackProfile): string {
    return `${profile.kind}/${profile.framework}/${profile.language}` +
        (profile.singleFile ? ` single-file(${profile.targetFile ?? '?'})` : '') +
        (profile.noThirdPartyImports ? ' no-libs' : '');
}
