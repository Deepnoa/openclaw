import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  CandidateFile,
  IngestDryRunData,
  KnowledgeActionResult,
  KnowledgePanelData,
  ManifestEntry,
  RetrievalEntry,
} from "../controllers/knowledge.ts";
import {
  executeConfirmedIngest,
  loadKnowledgePanel,
  runKnowledgeAction,
} from "../controllers/knowledge.ts";
import type { UiSettings } from "../storage.ts";

export type KnowledgeProps = {
  settings: UiSettings;
  connected: boolean;
  knowledgePanelLoading: boolean;
  knowledgePanelError: string | null;
  knowledgePanel: KnowledgePanelData | null;
  knowledgeActionLoading: boolean;
  knowledgeActionError: string | null;
  knowledgeActionResult: KnowledgeActionResult | null;
  knowledgeQuery: string;
  knowledgeConfirmPending: { path: string; dryRunResult: IngestDryRunData } | null;
  knowledgeConfirmExecuting: boolean;
  knowledgeConfirmResult: string | null;
  requestUpdate: () => void;
  onQueryChange: (q: string) => void;
  onAction: (
    action: "discover" | "retrieve" | "ingest_dry_run" | "propose",
    query?: string,
  ) => void;
  onDryRun: (path: string) => void;
  onConfirmExecute: (path: string) => void;
  onCancelConfirm: () => void;
  onRefresh: () => void;
};

// ── Pressure badge ─────────────────────────────────────────────────────────

function pressureClass(pressure: string): string {
  if (pressure === "critical") return "kn-badge--blocked";
  if (pressure === "high") return "kn-badge--review";
  if (pressure === "normal" || pressure === "low") return "kn-badge--allowed";
  return "kn-badge--dry-run";
}

function decisionClass(decision: string): string {
  if (decision === "blocked") return "kn-badge--blocked";
  if (decision === "review_required") return "kn-badge--review";
  if (decision === "allowed") return "kn-badge--allowed";
  return "kn-badge--dry-run";
}

// ── Sub-renders ────────────────────────────────────────────────────────────

function renderManifestEntry(entry: ManifestEntry) {
  return html`
    <div class="kn-manifest-card">
      <div class="kn-manifest-card__header">
        <span class="kn-manifest-card__title">${entry.title || entry.id}</span>
        <span class="kn-badge ${decisionClass(entry.decision)}">${entry.decision}</span>
        ${entry.sensitivity
          ? html`<span class="kn-badge kn-badge--dry-run">${entry.sensitivity}</span>`
          : nothing}
      </div>
      <div class="kn-manifest-card__meta">
        <span class="kn-muted">${entry.id}</span>
        ${entry.artifact_type
          ? html`<span class="kn-muted">${entry.artifact_type}</span>`
          : nothing}
        ${entry.lifecycle_state
          ? html`<span class="kn-muted">${entry.lifecycle_state}</span>`
          : nothing}
      </div>
    </div>
  `;
}

function renderCandidateCard(candidate: CandidateFile, onDryRun: (path: string) => void) {
  const canDryRun = !candidate.already_in_manifest;
  return html`
    <div class="kn-candidate-card">
      <div class="kn-candidate-card__header">
        <span class="kn-candidate-card__name">${candidate.filename}</span>
        ${candidate.sensitivity_guess
          ? html`<span class="kn-badge kn-badge--dry-run">${candidate.sensitivity_guess}</span>`
          : nothing}
        ${candidate.already_in_manifest
          ? html`<span class="kn-badge kn-badge--allowed">in manifest</span>`
          : nothing}
      </div>
      <div class="kn-candidate-card__path kn-muted">${candidate.path}</div>
      ${candidate.recommended_next_action
        ? html`<div class="kn-candidate-card__action-hint kn-muted">
            ${candidate.recommended_next_action}
          </div>`
        : nothing}
      ${canDryRun
        ? html`<button
            class="kn-action-btn kn-action-btn--secondary"
            @click=${() => onDryRun(candidate.path)}
          >
            Dry-Run
          </button>`
        : nothing}
    </div>
  `;
}

function renderRetrievalEntry(entry: RetrievalEntry) {
  const isBlocked = Boolean(entry.blocked_reason);
  return html`
    <div class="kn-manifest-card ${isBlocked ? "kn-manifest-card--blocked" : ""}">
      <div class="kn-manifest-card__header">
        <span class="kn-manifest-card__title">${entry.title || entry.id}</span>
        ${isBlocked
          ? html`<span class="kn-badge kn-badge--blocked">Blocked</span>`
          : html`<span class="kn-badge kn-badge--allowed">Retrieved</span>`}
        ${entry.sensitivity
          ? html`<span class="kn-badge kn-badge--dry-run">${entry.sensitivity}</span>`
          : nothing}
      </div>
      ${isBlocked
        ? html`<div class="kn-muted">${entry.blocked_reason}</div>`
        : html`
            ${entry.summary
              ? html`<div class="kn-manifest-card__summary">${entry.summary}</div>`
              : nothing}
            ${entry.explainability?.why_retrieval_decision
              ? html`<div class="kn-muted kn-explain">
                  ${entry.explainability.why_retrieval_decision}
                </div>`
              : nothing}
          `}
    </div>
  `;
}

function renderDryRunCard(
  dryRun: IngestDryRunData,
  confirmPending: { path: string; dryRunResult: IngestDryRunData } | null,
  onConfirm: (path: string) => void,
  onCancel: () => void,
  confirmExecuting: boolean,
  confirmResult: string | null,
) {
  const isAllowed = dryRun.decision === "allowed";
  return html`
    <div class="kn-manifest-card">
      <div class="kn-manifest-card__header">
        <span class="kn-manifest-card__title">Dry-Run Result</span>
        <span class="kn-badge ${decisionClass(dryRun.decision)}">${dryRun.decision}</span>
        ${dryRun.sensitivity
          ? html`<span class="kn-badge kn-badge--dry-run">${dryRun.sensitivity}</span>`
          : nothing}
      </div>
      <div class="kn-muted">${dryRun.path}</div>
      ${dryRun.decision_reason
        ? html`<div class="kn-muted kn-explain">${dryRun.decision_reason}</div>`
        : nothing}
      ${dryRun.runtime_pressure_note
        ? html`<div class="kn-muted">${dryRun.runtime_pressure_note}</div>`
        : nothing}
      ${isAllowed && confirmPending
        ? html`
            <div class="kn-confirm-area">
              <button
                class="kn-action-btn kn-action-btn--danger"
                ?disabled=${confirmExecuting}
                @click=${() => onConfirm(confirmPending.path)}
              >
                ${confirmExecuting ? "Executing…" : t("knowledge.confirmExecute")}
              </button>
              <button class="kn-action-btn kn-action-btn--secondary" @click=${onCancel}>
                ${t("knowledge.confirmModal_cancel")}
              </button>
            </div>
            ${confirmResult ? html`<div class="kn-confirm-result">${confirmResult}</div>` : nothing}
          `
        : nothing}
    </div>
  `;
}

function renderActionResults(
  result: KnowledgeActionResult,
  confirmPending: { path: string; dryRunResult: IngestDryRunData } | null,
  onDryRun: (path: string) => void,
  onConfirm: (path: string) => void,
  onCancel: () => void,
  confirmExecuting: boolean,
  confirmResult: string | null,
) {
  return html`
    <div class="kn-results">
      <div class="kn-results__header">
        <span class="kn-badge kn-badge--dry-run">${result.action}</span>
        <span
          class="kn-badge ${result.classification === "CANDIDATES_FOUND" ||
          result.classification === "RETRIEVED"
            ? "kn-badge--allowed"
            : "kn-badge--review"}"
          >${result.classification}</span
        >
        ${result.runtime_pressure_note
          ? html`<span class="kn-muted">${result.runtime_pressure_note}</span>`
          : nothing}
      </div>
      ${result.candidates?.length
        ? html`<div class="kn-result-section">
            <div class="kn-section-label">Candidates (${result.candidates.length})</div>
            ${result.candidates.map((c) => renderCandidateCard(c, onDryRun))}
          </div>`
        : nothing}
      ${result.entries?.length
        ? html`<div class="kn-result-section">
            <div class="kn-section-label">Retrieval Results (${result.entries.length})</div>
            ${result.entries.map(renderRetrievalEntry)}
          </div>`
        : nothing}
      ${result.dry_run
        ? html`<div class="kn-result-section">
            ${renderDryRunCard(
              result.dry_run,
              confirmPending,
              onConfirm,
              onCancel,
              confirmExecuting,
              confirmResult,
            )}
          </div>`
        : nothing}
      ${!result.candidates?.length && !result.entries?.length && !result.dry_run
        ? html`<div class="kn-muted">No results returned.</div>`
        : nothing}
    </div>
  `;
}

// ── Main render ────────────────────────────────────────────────────────────

export function renderKnowledge(props: KnowledgeProps) {
  const {
    connected,
    knowledgePanelLoading,
    knowledgePanelError,
    knowledgePanel,
    knowledgeActionLoading,
    knowledgeActionError,
    knowledgeActionResult,
    knowledgeQuery,
    knowledgeConfirmPending,
    knowledgeConfirmExecuting,
    knowledgeConfirmResult,
    onQueryChange,
    onAction,
    onDryRun,
    onConfirmExecute,
    onCancelConfirm,
    onRefresh,
  } = props;

  const panel = knowledgePanel;
  const pressure = panel?.runtime_pressure ?? "unknown";

  return html`
    <div class="kn-panel">
      <!-- Status bar -->
      <div class="kn-status-bar">
        <div class="kn-status-bar__left">
          <span class="kn-label">${t("knowledge.title")}</span>
          ${panel
            ? html`
                <span class="kn-badge ${pressureClass(pressure)}">${pressure}</span>
                <span class="kn-muted"
                  >${panel.safe_manifest_count} ${t("knowledge.manifestCount")}</span
                >
              `
            : knowledgePanelLoading
              ? html`<span class="kn-muted">Loading…</span>`
              : knowledgePanelError
                ? html`<span class="kn-badge kn-badge--blocked">${knowledgePanelError}</span>`
                : nothing}
        </div>
        <div class="kn-status-bar__right">
          <button
            class="kn-action-btn kn-action-btn--secondary"
            ?disabled=${knowledgePanelLoading || !connected}
            @click=${onRefresh}
          >
            ↻
          </button>
        </div>
      </div>

      ${panel?.last_updated
        ? html`<div class="kn-last-updated kn-muted">Updated ${panel.last_updated}</div>`
        : nothing}

      <!-- Action bar -->
      <div class="kn-action-bar">
        <input
          class="kn-query-input"
          type="text"
          placeholder="${t("knowledge.queryPlaceholder")}"
          .value=${knowledgeQuery}
          @input=${(e: Event) => onQueryChange((e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") onAction("propose", knowledgeQuery);
          }}
        />
        <button
          class="kn-action-btn"
          ?disabled=${knowledgeActionLoading || !connected}
          @click=${() => onAction("propose", knowledgeQuery)}
        >
          ${t("knowledge.propose")}
        </button>
        <button
          class="kn-action-btn kn-action-btn--secondary"
          ?disabled=${knowledgeActionLoading || !connected}
          @click=${() => onAction("discover", knowledgeQuery)}
        >
          ${t("knowledge.discover")}
        </button>
        <button
          class="kn-action-btn kn-action-btn--secondary"
          ?disabled=${knowledgeActionLoading || !connected}
          @click=${() => onAction("retrieve", knowledgeQuery)}
        >
          ${t("knowledge.retrieve")}
        </button>
      </div>

      <!-- Action result -->
      ${knowledgeActionLoading ? html`<div class="kn-muted kn-loading">Running…</div>` : nothing}
      ${knowledgeActionError ? html`<div class="kn-error">${knowledgeActionError}</div>` : nothing}
      ${!knowledgeActionLoading && knowledgeActionResult
        ? renderActionResults(
            knowledgeActionResult,
            knowledgeConfirmPending,
            onDryRun,
            onConfirmExecute,
            onCancelConfirm,
            knowledgeConfirmExecuting,
            knowledgeConfirmResult,
          )
        : nothing}

      <!-- Manifest registry -->
      ${panel?.manifest_entries?.length
        ? html`
            <div class="kn-section">
              <div class="kn-section-label">Manifest Registry (${panel.safe_manifest_count})</div>
              <div class="kn-manifest-list">${panel.manifest_entries.map(renderManifestEntry)}</div>
            </div>
          `
        : nothing}

      <!-- Last orchestration / discovery -->
      ${panel?.last_orchestration || panel?.last_discovery
        ? html`
            <div class="kn-section">
              <div class="kn-section-label">Recent Activity</div>
              ${panel.last_orchestration
                ? html`
                    <div class="kn-activity-row">
                      <span class="kn-muted">Orchestration:</span>
                      <span class="kn-badge kn-badge--dry-run"
                        >${panel.last_orchestration.action ?? "—"}</span
                      >
                      <span
                        class="kn-badge ${decisionClass(
                          panel.last_orchestration.classification ?? "",
                        )}"
                        >${panel.last_orchestration.classification ?? "—"}</span
                      >
                      <span class="kn-muted">${panel.last_orchestration.timestamp ?? ""}</span>
                    </div>
                  `
                : nothing}
              ${panel.last_discovery
                ? html`
                    <div class="kn-activity-row">
                      <span class="kn-muted">Discovery:</span>
                      <span class="kn-badge kn-badge--dry-run"
                        >${panel.last_discovery.query ?? "—"}</span
                      >
                      <span class="kn-muted"
                        >${panel.last_discovery.candidates_returned} candidates</span
                      >
                      <span class="kn-muted">${panel.last_discovery.timestamp ?? ""}</span>
                    </div>
                  `
                : nothing}
            </div>
          `
        : nothing}
    </div>
  `;
}
