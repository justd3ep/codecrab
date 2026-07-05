/*---------------------------------------------------------------------------------------------
 *  CodeCrab Dark Theme — Color Palette
 *  Deep ocean blue background with orange crab accent.
 *
 *  This file exports the color tokens used by CodeCrab UI components.
 *  The actual VS Code theme registration happens via extension contribution
 *  in the product's package.json / theme extension (Phase 2).
 *
 *  Palette:
 *    Ocean Deep:    #0A1628  (primary background)
 *    Ocean Mid:     #0D1F3C  (sidebar, activitybar)
 *    Ocean Shallow: #122040  (panel headers, hover)
 *    Ocean Surface: #1A2E52  (selections, highlights)
 *    Crab Orange:   #FF6B35  (accent, status bar, buttons)
 *    Crab Light:    #FF8C5A  (hover accent)
 *    Crab Glow:     #FF6B3520 (transparent accent for backgrounds)
 *    Text Primary:  #E8EDF5  (main text)
 *    Text Secondary:#8BA3C7  (muted text, comments)
 *    Text Accent:   #FF6B35  (active, highlighted text)
 *    Border:        #1E3360  (dividers, borders)
 *    Error:         #FF4757  (errors)
 *    Warning:       #FFA502  (warnings)
 *    Success:       #2ED573  (success states)
 *--------------------------------------------------------------------------------------------*/

// ---------------------------------------------------------------------------
// Exported color tokens for use in CodeCrab UI components
// ---------------------------------------------------------------------------

export const CODECRAB_COLORS = {

	// ── Editor ──────────────────────────────────────────────────────────
	editorBackground: '#0A1628',
	editorForeground: '#E8EDF5',
	editorLineHighlight: '#0D1F3C',
	editorSelection: '#1A2E52',
	editorFindMatch: '#FF6B3540',

	// ── Backgrounds ────────────────────────────────────────────────────
	oceanDeep: '#0A1628',
	oceanMid: '#0D1F3C',
	oceanShallow: '#122040',
	oceanSurface: '#1A2E52',
	panelBackground: '#080F1E',

	// ── Accent ─────────────────────────────────────────────────────────
	crabOrange: '#FF6B35',
	crabLight: '#FF8C5A',
	crabGlow: '#FF6B3520',
	crabDark: '#E05A28',

	// ── Text ───────────────────────────────────────────────────────────
	textPrimary: '#E8EDF5',
	textSecondary: '#8BA3C7',
	textMuted: '#5A7AA0',
	textDisabled: '#3A547A',

	// ── Borders ────────────────────────────────────────────────────────
	border: '#1E3360',
	borderActive: '#2A4070',

	// ── Semantic ───────────────────────────────────────────────────────
	error: '#FF4757',
	warning: '#FFA502',
	success: '#2ED573',

	// ── Status Bar ──────────────────────────────────────────────────────
	statusBarBackground: '#FF6B35',
	statusBarForeground: '#FFFFFF',
} as const;

/**
 * The CodeCrab Dark theme ID. Used to reference the theme in
 * extension contributions and settings.
 */
export const CODECRAB_THEME_ID = 'codecrab-dark';
export const CODECRAB_THEME_LABEL = 'CodeCrab Dark';
