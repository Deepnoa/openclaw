import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  CandidateFile,
  ConsumptionStats,
  IngestDryRunData,
  KnowledgeActionResult,
  KnowledgeGraphData,
  KnowledgePanelData,
  ManifestDetailData,
  ManifestEntry,
  RetrievalEntry,
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
  knowledgeManifestDetailId: string | null;
  knowledgeManifestDetail: ManifestDetailData | null;
  knowledgeManifestDetailLoading: boolean;
  knowledgeManifestDetailError: string | null;
  knowledgeGraph: KnowledgeGraphData | null;
  knowledgeGraphLoading: boolean;
  knowledgeGraphError: string | null;
  knowledgeGraphFilter: { nodeType: string | null; relation: string | null };
  knowledgeConsumptionStats: ConsumptionStats | null;
  knowledgeConsumptionStatsLoading: boolean;
  knowledgeConsumptionStatsError: string | null;
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
  onManifestSelect: (id: string) => void;
  onManifestDetailClose: () => void;
  onGraphFilterChange: (filter: { nodeType: string | null; relation: string | null }) => void;
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

function lifecycleClass(lifecycle: string | undefined): string {
  if (lifecycle === "active") return "kn-badge--allowed";
  if (lifecycle === "archived") return "kn-badge--dry-run";
  return "kn-badge--review";
}

function renderBoolBadge(label: string, value: boolean | undefined) {
  if (value === undefined) return nothing;
  return html`<span class="kn-badge ${value ? "kn-badge--allowed" : "kn-badge--blocked"}"
    >${label}: ${value ? "yes" : "no"}</span
  >`;
}

// ── Sub-renders ────────────────────────────────────────────────────────────

function renderManifestEntry(
  entry: ManifestEntry,
  onSelect: (id: string) => void,
  selectedId: string | null,
) {
  const isSelected = selectedId === entry.id;
  return html`
    <div
      class="kn-manifest-card kn-manifest-card--clickable ${isSelected
        ? "kn-manifest-card--selected"
        : ""}"
      role="button"
      tabindex="0"
      @click=${() => onSelect(entry.id)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(entry.id);
        }
      }}
    >
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

function renderSummary(summary: string | Record<string, unknown>) {
  if (typeof summary === "string") {
    return html`<div class="kn-manifest-card__summary">${summary}</div>`;
  }
  const title = typeof summary.title_guess === "string" ? summary.title_guess : null;
  const keywords = Array.isArray(summary.keywords_guess)
    ? (summary.keywords_guess as string[]).join(", ")
    : null;
  const basis = typeof summary.summary_basis === "string" ? summary.summary_basis : null;
  return html`<div class="kn-manifest-card__summary">
    ${title ? html`<span class="kn-summary-title">${title}</span>` : nothing}
    ${keywords ? html`<span class="kn-muted kn-summary-keywords">${keywords}</span>` : nothing}
    ${basis ? html`<span class="kn-muted kn-summary-basis">${basis}</span>` : nothing}
  </div>`;
}

// Related manifests: same sensitivity OR same artifact_type, excluding self, max 3.
// Clickable — opens the manifest detail panel (Item 1).
function findRelatedManifests(
  entry: RetrievalEntry,
  manifestEntries: ManifestEntry[] | undefined,
): ManifestEntry[] {
  if (!manifestEntries?.length) return [];
  return manifestEntries
    .filter(
      (m) =>
        m.id !== entry.id &&
        ((entry.sensitivity && m.sensitivity === entry.sensitivity) ||
          (entry.artifact_type && m.artifact_type === entry.artifact_type)),
    )
    .slice(0, 3);
}

function renderRetrievalEntry(
  entry: RetrievalEntry,
  manifestEntries: ManifestEntry[] | undefined,
  onManifestSelect: (id: string) => void,
) {
  const isBlocked = Boolean(entry.blocked_reason);
  const whyMatched = entry.explainability?.why_retrieval_decision;
  const related = isBlocked ? [] : findRelatedManifests(entry, manifestEntries);
  return html`
    <div class="kn-manifest-card ${isBlocked ? "kn-manifest-card--blocked" : ""}">
      <div class="kn-manifest-card__header">
        <span class="kn-manifest-card__title">${entry.title || entry.id}</span>
        ${isBlocked
          ? html`<span class="kn-badge kn-badge--blocked">${t("knowledge.blocked")}</span>`
          : html`<span class="kn-badge kn-badge--allowed">${t("knowledge.retrieved")}</span>`}
        ${entry.lifecycle_state
          ? html`<span class="kn-badge ${lifecycleClass(entry.lifecycle_state)}"
              >${entry.lifecycle_state}</span
            >`
          : nothing}
        ${entry.sensitivity
          ? html`<span class="kn-badge kn-badge--dry-run">${entry.sensitivity}</span>`
          : nothing}
      </div>
      ${isBlocked
        ? html`<div class="kn-muted kn-explain">
            <span class="kn-detail-key">${t("knowledge.blockedReason")}</span>
            ${entry.blocked_reason}
          </div>`
        : html`
            ${entry.summary ? renderSummary(entry.summary) : nothing}
            ${whyMatched
              ? html`<div class="kn-why">
                  <span class="kn-why-badge">${t("knowledge.whyMatched")}</span>
                  <span class="kn-muted">${whyMatched}</span>
                </div>`
              : nothing}
            ${related.length
              ? html`<div class="kn-related">
                  <span class="kn-detail-key">${t("knowledge.related")}</span>
                  ${related.map(
                    (m) => html`<button
                      class="kn-related-link"
                      @click=${() => onManifestSelect(m.id)}
                    >
                      ${m.title || m.id}
                    </button>`,
                  )}
                </div>`
              : nothing}
            <div class="kn-citation-line">
              <span class="kn-detail-key">${t("knowledge.citation")}</span>
              ${entry.id}${entry.artifact_type ? html` · ${entry.artifact_type}` : nothing}
            </div>
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
  manifestEntries: ManifestEntry[] | undefined,
  onManifestSelect: (id: string) => void,
) {
  const entries = result.entries ?? [];
  const retrievedCount = entries.filter((e) => !e.blocked_reason).length;
  const blockedCount = entries.filter((e) => Boolean(e.blocked_reason)).length;
  const retrievedIds = entries
    .filter((e) => !e.blocked_reason)
    .map((e) => e.id)
    .filter(Boolean);
  return html`
    <div class="kn-results">
      <div class="kn-results__header">
        <span class="kn-badge kn-badge--dry-run">${result.action}</span>
        <span class="kn-results__label">${t("knowledge.classification")}</span>
        <span
          class="kn-badge ${result.classification === "CANDIDATES_FOUND" ||
          result.classification === "RETRIEVED"
            ? "kn-badge--allowed"
            : "kn-badge--review"}"
          >${result.classification}</span
        >
        ${entries.length
          ? html`
              <span class="kn-badge kn-badge--allowed"
                >${retrievedCount} ${t("knowledge.retrieved")}</span
              >
              ${blockedCount
                ? html`<span class="kn-badge kn-badge--blocked"
                    >${blockedCount} ${t("knowledge.blocked")}</span
                  >`
                : nothing}
            `
          : nothing}
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
      ${entries.length
        ? html`<div class="kn-result-section">
            <div class="kn-section-label">Retrieval Results (${entries.length})</div>
            ${entries.map((e) => renderRetrievalEntry(e, manifestEntries, onManifestSelect))}
            ${retrievedIds.length
              ? html`<div class="kn-provenance kn-muted">
                  <span class="kn-detail-key">${t("knowledge.provenance")}</span>
                  knowledge-assist → manifest-registry → ${retrievedIds.join(", ")}
                </div>`
              : nothing}
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
      ${!result.candidates?.length && !entries.length && !result.dry_run
        ? html`<div class="kn-muted">${t("knowledge.noRetrievalResults")}</div>`
        : nothing}
    </div>
  `;
}

// ── Manifest detail panel (Item 1) ───────────────────────────────────────────

function renderManifestDetail(props: KnowledgeProps) {
  const {
    knowledgeManifestDetailId,
    knowledgeManifestDetail,
    knowledgeManifestDetailLoading,
    knowledgeManifestDetailError,
    onManifestDetailClose,
  } = props;

  if (!knowledgeManifestDetailId) {
    return nothing;
  }

  const detail = knowledgeManifestDetail;
  const entry = detail?.entry;

  return html`
    <div class="kn-detail-overlay" @click=${onManifestDetailClose}></div>
    <aside class="kn-detail-panel" role="dialog" aria-label="${t("knowledge.detailTitle")}">
      <div class="kn-detail-panel__header">
        <span class="kn-detail-panel__title"> ${entry?.title || knowledgeManifestDetailId} </span>
        ${entry?.lifecycle_state
          ? html`<span class="kn-badge ${lifecycleClass(entry.lifecycle_state)}"
              >${entry.lifecycle_state}</span
            >`
          : nothing}
        <button
          class="kn-detail-close"
          aria-label="${t("knowledge.detailClose")}"
          @click=${onManifestDetailClose}
        >
          ✕
        </button>
      </div>

      ${knowledgeManifestDetailLoading
        ? html`<div class="kn-muted kn-loading">${t("knowledge.detailLoading")}</div>`
        : knowledgeManifestDetailError
          ? html`<div class="kn-error">${knowledgeManifestDetailError}</div>`
          : entry
            ? html`
                <!-- Section 1: Governance -->
                <div class="kn-detail-section">
                  <div class="kn-detail-section__label">${t("knowledge.detailGovernance")}</div>
                  <div class="kn-detail-row">
                    <span class="kn-detail-key">${t("knowledge.decision")}</span>
                    <span class="kn-badge ${decisionClass(entry.decision ?? "")}"
                      >${entry.decision ?? "—"}</span
                    >
                  </div>
                  ${entry.decision_reason
                    ? html`<div class="kn-detail-row">
                        <span class="kn-detail-key">${t("knowledge.decisionReason")}</span>
                        <span class="kn-muted">${entry.decision_reason}</span>
                      </div>`
                    : nothing}
                  ${entry.sensitivity
                    ? html`<div class="kn-detail-row">
                        <span class="kn-detail-key">${t("knowledge.sensitivity")}</span>
                        <span class="kn-badge kn-badge--dry-run">${entry.sensitivity}</span>
                      </div>`
                    : nothing}
                </div>

                <!-- Section 2: Capabilities -->
                <div class="kn-detail-section">
                  <div class="kn-detail-section__label">${t("knowledge.detailCapabilities")}</div>
                  <div class="kn-detail-badges">
                    ${renderBoolBadge(t("knowledge.retrievalAllowed"), entry.retrieval_allowed)}
                    ${renderBoolBadge(t("knowledge.exportAllowed"), entry.export_allowed)}
                    ${renderBoolBadge(t("knowledge.ragSafe"), entry.rag_safe)}
                  </div>
                </div>

                <!-- Usage metrics (Phase B Item 5) -->
                ${detail?.usage
                  ? html`<div class="kn-detail-section">
                      <div class="kn-detail-section__label">${t("knowledge.detailUsage")}</div>
                      <div class="kn-detail-row">
                        <span class="kn-detail-key">${t("knowledge.usageRetrievalCount")}</span>
                        <span>${detail.usage.retrieval_count}</span>
                      </div>
                      ${detail.usage.first_retrieved
                        ? html`<div class="kn-detail-row">
                            <span class="kn-detail-key">${t("knowledge.usageFirstRetrieved")}</span>
                            <span class="kn-muted">${detail.usage.first_retrieved}</span>
                          </div>`
                        : nothing}
                      ${detail.usage.last_retrieved
                        ? html`<div class="kn-detail-row">
                            <span class="kn-detail-key">${t("knowledge.usageLastRetrieved")}</span>
                            <span class="kn-muted">${detail.usage.last_retrieved}</span>
                          </div>`
                        : nothing}
                    </div>`
                  : nothing}

                <!-- Section 3: Retrieval History -->
                <div class="kn-detail-section">
                  <div class="kn-detail-section__label">
                    ${t("knowledge.detailRetrievalHistory")}
                  </div>
                  ${detail?.retrieval_history?.length
                    ? html`<div class="kn-detail-history">
                        ${detail.retrieval_history.map(
                          (h) => html`
                            <div class="kn-detail-history-item">
                              <span class="kn-muted">${h.timestamp}</span>
                              ${h.classification
                                ? html`<span class="kn-badge kn-badge--dry-run"
                                    >${h.classification}</span
                                  >`
                                : nothing}
                              ${h.query
                                ? html`<span class="kn-muted">"${h.query}"</span>`
                                : nothing}
                            </div>
                          `,
                        )}
                      </div>`
                    : html`<div class="kn-muted">${t("knowledge.detailNoHistory")}</div>`}
                </div>

                <!-- Section 4: Runtime References -->
                <div class="kn-detail-section">
                  <div class="kn-detail-section__label">${t("knowledge.detailRuntimeRefs")}</div>
                  ${detail?.runtime_references?.length
                    ? html`<div class="kn-detail-history">
                        ${detail.runtime_references.map(
                          (r) => html`
                            <div class="kn-detail-history-item">
                              <span class="kn-badge kn-badge--dry-run">${r.domain}</span>
                              <span class="kn-muted">${r.reference_type}</span>
                              <span class="kn-muted">${r.timestamp}</span>
                            </div>
                          `,
                        )}
                      </div>`
                    : html`<div class="kn-muted">${t("knowledge.detailNoRuntimeRefs")}</div>`}
                </div>

                <!-- Section 5: System -->
                <div class="kn-detail-section">
                  <div class="kn-detail-section__label">${t("knowledge.detailSystem")}</div>
                  <div class="kn-detail-row">
                    <span class="kn-detail-key">${t("knowledge.id")}</span>
                    <span class="kn-citation-line">${entry.id}</span>
                  </div>
                  ${entry.artifact_type
                    ? html`<div class="kn-detail-row">
                        <span class="kn-detail-key">${t("knowledge.artifactType")}</span>
                        <span class="kn-muted">${entry.artifact_type}</span>
                      </div>`
                    : nothing}
                  ${entry.created_at
                    ? html`<div class="kn-detail-row">
                        <span class="kn-detail-key">${t("knowledge.createdAt")}</span>
                        <span class="kn-muted">${entry.created_at}</span>
                      </div>`
                    : nothing}
                </div>
              `
            : html`<div class="kn-muted">${t("knowledge.detailNoData")}</div>`}
    </aside>
  `;
}

// ── Runtime reference graph (Item 4a) — table view only ──────────────────────

function renderKnowledgeGraph(props: KnowledgeProps) {
  const { knowledgeGraph, knowledgeGraphLoading, knowledgeGraphError, knowledgeGraphFilter } =
    props;
  if (knowledgeGraphLoading && !knowledgeGraph) {
    return html`<div class="kn-section">
      <div class="kn-section-label">${t("knowledge.graphTitle")}</div>
      <div class="kn-muted kn-loading">${t("knowledge.graphLoading")}</div>
    </div>`;
  }
  if (knowledgeGraphError) {
    return html`<div class="kn-section">
      <div class="kn-section-label">${t("knowledge.graphTitle")}</div>
      <div class="kn-error">${knowledgeGraphError}</div>
    </div>`;
  }
  if (!knowledgeGraph) {
    return nothing;
  }

  const nodeById = new Map(knowledgeGraph.nodes.map((n) => [n.id, n]));
  const relationsPresent = [...new Set(knowledgeGraph.edges.map((e) => e.relation))].sort();
  const nodeTypesPresent = [...new Set(knowledgeGraph.nodes.map((n) => n.type))].sort();

  const matchesFilter = (edge: (typeof knowledgeGraph.edges)[number]): boolean => {
    if (knowledgeGraphFilter.relation && edge.relation !== knowledgeGraphFilter.relation) {
      return false;
    }
    if (knowledgeGraphFilter.nodeType) {
      const s = nodeById.get(edge.source)?.type;
      const tt = nodeById.get(edge.target)?.type;
      if (s !== knowledgeGraphFilter.nodeType && tt !== knowledgeGraphFilter.nodeType) {
        return false;
      }
    }
    return true;
  };

  const rows = knowledgeGraph.edges.filter(matchesFilter);

  return html`
    <div class="kn-section">
      <div class="kn-section-label">
        ${t("knowledge.graphTitle")} (${knowledgeGraph.node_count} ${t("knowledge.graphNodes")},
        ${knowledgeGraph.edge_count} ${t("knowledge.graphEdges")})
      </div>

      <div class="kn-graph-filters">
        <select
          class="kn-graph-filter"
          @change=${(e: Event) =>
            props.onGraphFilterChange({
              ...knowledgeGraphFilter,
              nodeType: (e.target as HTMLSelectElement).value || null,
            })}
        >
          <option value="" ?selected=${!knowledgeGraphFilter.nodeType}>
            ${t("knowledge.graphAllNodeTypes")}
          </option>
          ${nodeTypesPresent.map(
            (nt) =>
              html`<option value=${nt} ?selected=${knowledgeGraphFilter.nodeType === nt}>
                ${nt}
              </option>`,
          )}
        </select>
        <select
          class="kn-graph-filter"
          @change=${(e: Event) =>
            props.onGraphFilterChange({
              ...knowledgeGraphFilter,
              relation: (e.target as HTMLSelectElement).value || null,
            })}
        >
          <option value="" ?selected=${!knowledgeGraphFilter.relation}>
            ${t("knowledge.graphAllRelations")}
          </option>
          ${relationsPresent.map(
            (r) =>
              html`<option value=${r} ?selected=${knowledgeGraphFilter.relation === r}>
                ${r}
              </option>`,
          )}
        </select>
      </div>

      ${rows.length
        ? html`<table class="kn-graph-table">
            <thead>
              <tr>
                <th>${t("knowledge.graphSource")}</th>
                <th>${t("knowledge.graphRelation")}</th>
                <th>${t("knowledge.graphTarget")}</th>
                <th>${t("knowledge.graphTimestamp")}</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((edge) => {
                const sourceNode = nodeById.get(edge.source);
                const targetNode = nodeById.get(edge.target);
                return html`<tr>
                  <td>
                    <span class="kn-graph-node-type kn-graph-node-type--${sourceNode?.type ?? ""}"
                      >${sourceNode?.type ?? "?"}</span
                    >
                    ${sourceNode?.label ?? edge.source}
                  </td>
                  <td><span class="kn-badge kn-badge--dry-run">${edge.relation}</span></td>
                  <td>
                    <span class="kn-graph-node-type kn-graph-node-type--${targetNode?.type ?? ""}"
                      >${targetNode?.type ?? "?"}</span
                    >
                    ${targetNode?.label ?? edge.target}
                  </td>
                  <td class="kn-muted">${edge.timestamp ?? "—"}</td>
                </tr>`;
              })}
            </tbody>
          </table>`
        : html`<div class="kn-muted">${t("knowledge.graphNoEdges")}</div>`}
    </div>
  `;
}

// ── Usage stats (Item 5) ─────────────────────────────────────────────────────

function renderUsageStats(props: KnowledgeProps) {
  const {
    knowledgeConsumptionStats,
    knowledgeConsumptionStatsLoading,
    knowledgeConsumptionStatsError,
  } = props;
  if (knowledgeConsumptionStatsLoading && !knowledgeConsumptionStats) {
    return html`<div class="kn-section">
      <div class="kn-section-label">${t("knowledge.usageTitle")}</div>
      <div class="kn-muted kn-loading">${t("knowledge.usageLoading")}</div>
    </div>`;
  }
  if (knowledgeConsumptionStatsError) {
    return html`<div class="kn-section">
      <div class="kn-section-label">${t("knowledge.usageTitle")}</div>
      <div class="kn-error">${knowledgeConsumptionStatsError}</div>
    </div>`;
  }
  const stats = knowledgeConsumptionStats;
  if (!stats) {
    return nothing;
  }
  return html`
    <div class="kn-section">
      <div class="kn-section-label">${t("knowledge.usageTitle")} (${stats.window_days}d)</div>
      <div class="kn-usage-metrics">
        <div class="kn-usage-metric">
          <span class="kn-usage-value">${stats.total_retrievals}</span>
          <span class="kn-muted">${t("knowledge.usageTotalRetrievals")}</span>
        </div>
        <div class="kn-usage-metric">
          <span class="kn-usage-value">${stats.total_discoveries}</span>
          <span class="kn-muted">${t("knowledge.usageTotalDiscoveries")}</span>
        </div>
        <div class="kn-usage-metric">
          <span class="kn-usage-value ${stats.blocked_attempts ? "kn-usage-value--warn" : ""}"
            >${stats.blocked_attempts}</span
          >
          <span class="kn-muted">${t("knowledge.usageBlockedAttempts")}</span>
        </div>
        <div class="kn-usage-metric">
          <span class="kn-usage-value ${stats.stale_references ? "kn-usage-value--warn" : ""}"
            >${stats.stale_references}</span
          >
          <span class="kn-muted">${t("knowledge.usageStaleReferences")}</span>
        </div>
      </div>

      ${stats.top_manifests.length
        ? html`<div class="kn-usage-block">
            <div class="kn-usage-block__label">${t("knowledge.usageTopManifests")}</div>
            ${stats.top_manifests.map(
              (m) => html`<div class="kn-usage-row">
                <button class="kn-related-link" @click=${() => props.onManifestSelect(m.id)}>
                  ${m.title || m.id}
                </button>
                <span class="kn-muted">${m.count} ${t("knowledge.retrieved")}</span>
              </div>`,
            )}
          </div>`
        : nothing}
      ${stats.unused_manifests.length
        ? html`<div class="kn-usage-block">
            <div class="kn-usage-block__label">
              ${t("knowledge.usageUnusedManifests")} (${stats.unused_manifests.length})
            </div>
            <div class="kn-usage-unused">
              ${stats.unused_manifests.map(
                (id) => html`<button
                  class="kn-related-link"
                  @click=${() => props.onManifestSelect(id)}
                >
                  ${id}
                </button>`,
              )}
            </div>
          </div>`
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
    knowledgeManifestDetailId,
    onQueryChange,
    onAction,
    onDryRun,
    onConfirmExecute,
    onCancelConfirm,
    onRefresh,
    onManifestSelect,
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
            panel?.manifest_entries,
            onManifestSelect,
          )
        : nothing}

      <!-- Manifest registry -->
      ${panel?.manifest_entries?.length
        ? html`
            <div class="kn-section">
              <div class="kn-section-label">Manifest Registry (${panel.safe_manifest_count})</div>
              <div class="kn-manifest-list">
                ${panel.manifest_entries.map((entry) =>
                  renderManifestEntry(entry, onManifestSelect, knowledgeManifestDetailId),
                )}
              </div>
            </div>
          `
        : nothing}

      <!-- Usage stats (Item 5) -->
      ${renderUsageStats(props)}

      <!-- Runtime reference graph (Item 4a) -->
      ${renderKnowledgeGraph(props)}

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

      <!-- Manifest detail panel (Item 1) -->
      ${renderManifestDetail(props)}
    </div>
  `;
}
