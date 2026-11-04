import React, { useEffect, useMemo, useState } from "react";
import { useFocusable, FocusContext } from "@noriginmedia/norigin-spatial-navigation-react";
import { LuArrowLeft as ArrowLeft, LuPlay as Play } from "react-icons/lu";
import type { Stream } from "../../lib/providers/types";
import { defaultStreamFilters, filterStreams, getStreamFilterOptions } from "../../lib/player/streamFilters";
import { badgeLabel, streamBadges } from "../../lib/player/streamBadges";
import { streamInfoHash } from "../../lib/player/swarmHealth";
import {
  claimSwarmTest,
  describeProgress,
  describeTest,
  freshResult,
  slowLanguageHint,
  sortBySpeed,
  testProgress,
  useSwarmTestStore,
  useSwarmTests,
  type SourceSort,
  type TestLine,
} from "../../lib/player/swarmTests";
import { FocusableButton } from "../layout/FocusableButton";

const chip = (active: boolean): React.CSSProperties => ({
  padding: "6px 12px",
  borderRadius: 999,
  border: "1px solid var(--outline-variant)",
  background: active ? "var(--secondary-container)" : "transparent",
  color: active ? "var(--on-secondary-container)" : "var(--on-surface-variant)",
  fontSize: 13,
  cursor: "pointer",
});

const qualityLabel = (quality: string) =>
  quality === "UNKNOWN" ? "Unspecified" : quality === "2160" ? "4K" : `${quality}p`;
const languageLabel = (language: string) =>
  language === "UNKNOWN" ? "Unspecified" : language === "MULTI" ? "Multi" : language;

const TEST_COLORS: Record<TestLine["tone"], string> = {
  good: "#7FD8A8",
  ok: "#F2C46D",
  bad: "#FF8A80",
  pending: "var(--on-surface-variant)",
};

/** What the swarm test measured: speed and peers, or why it will not play. */
function TestResult({ line }: { line: TestLine }) {
  const icon = line.tone === "pending" ? "⏳" : line.tone === "bad" ? "⚠" : "⚡";
  return (
    <div style={{ fontSize: 13, fontWeight: 600, color: TEST_COLORS[line.tone], marginBottom: 8 }}>
      {icon} {line.text}
    </div>
  );
}

function Badge({ text }: { text: string }) {
  const seeders = text.match(/^(?:👤\s*|S:\s*)(\d+)$/i)?.[1];
  const online = text.match(/^👥\s*(\d+)$/)?.[1];
  const live = seeders !== undefined || online !== undefined;
  const dead = text === "No peers";
  const quality = /^\d{3,4}p$|^4k$/i.test(text);
  return (
    <span
      style={{
        padding: "3px 8px",
        borderRadius: 7,
        fontSize: 12,
        background: live ? "#163D31" : dead ? "#4A1F1F" : quality ? "var(--primary-container)" : "var(--surface-container-high)",
        color: live ? "#A5E8C8" : dead ? "#FFB4AB" : quality ? "var(--on-primary-container)" : "var(--on-surface-variant)",
      }}
    >
      {badgeLabel(text)}
    </span>
  );
}

/**
 * The source list a movie or an episode opens on: quality and language
 * filters, each release with its tracker, name, seeders and size. The top
 * releases are joined for a few seconds to measure peers and speed, and the
 * list is ordered by what that measured.
 */
export const SourcePickerDialog: React.FC<{
  streams: Stream[];
  hiddenStreams?: Stream[];
  checking?: boolean;
  subtitle?: string;
  onSelect: (stream: Stream) => void;
  onBack: () => void;
}> = ({ streams, hiddenStreams = [], checking = false, subtitle, onSelect, onBack }) => {
  const { ref, focusKey, focusSelf } = useFocusable({ isFocusBoundary: true, trackChildren: true, focusKey: "SOURCE_PICKER" });
  // Russian (else English) at the best quality until the viewer picks filters.
  const [chosen, setChosen] = useState<{ qualities: string[]; languages: string[] } | undefined>();
  const defaults = useMemo(() => defaultStreamFilters(streams), [streams]);
  const { qualities, languages } = chosen || defaults;
  const setQualities = (next: string[]) => setChosen({ qualities: next, languages });
  const setLanguages = (next: string[]) => setChosen({ qualities, languages: next });
  const [showHidden, setShowHidden] = useState(false);
  const [sort, setSort] = useState<SourceSort>("speed");
  const options = useMemo(() => getStreamFilterOptions(streams), [streams]);
  const matching = useMemo(
    () => filterStreams(showHidden ? [...streams, ...hiddenStreams] : streams, qualities, languages),
    [streams, hiddenStreams, showHidden, qualities, languages],
  );
  // Test in the order shown before the results arrive: best swarms first.
  const candidates = useMemo(() => sortBySpeed(matching, {}, sort), [matching, sort]);
  const { results, running, live } = useSwarmTests(candidates, true);
  const listed = useMemo(() => sortBySpeed(matching, results, sort), [matching, results, sort]);
  const progress = testProgress(listed, results, running);
  const progressText = describeProgress(progress);
  const hint = slowLanguageHint(listed, streams, results, languages);
  // Swarms change: measure the listed releases again.
  const recheck = () =>
    useSwarmTestStore.getState().recheck(listed.map(streamInfoHash).filter((hash): hash is string => Boolean(hash)));
  const select = (stream: Stream) => {
    // Keep the tested torrent (and its peers) for playback.
    void claimSwarmTest(stream).finally(() => onSelect(stream));
  };
  useEffect(() => {
    const timer = setTimeout(() => focusSelf(), 30);
    return () => clearTimeout(timer);
  }, [focusSelf]);
  const toggle = (values: string[], value: string) =>
    values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 95,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(0,0,0,0.92)",
          padding: 24,
        }}
      >
        <div
          style={{
            width: "min(1100px, 100%)",
            height: "min(760px, 100%)",
            display: "flex",
            flexDirection: "column",
            background: "var(--surface-container)",
            borderRadius: 24,
            padding: 20,
            color: "var(--on-surface)",
            boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <FocusableButton focusKey="SOURCE_PICKER_BACK" aria-label="Go back" onClick={onBack} className="player-loading-back" style={{ position: "static" }}>
              <ArrowLeft size={22} />
            </FocusableButton>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 22, fontWeight: 600 }}>Choose a source</div>
              {subtitle && <div style={{ fontSize: 13, color: "var(--on-surface-variant)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{subtitle}</div>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 20, flex: 1, minHeight: 0 }}>
            <div style={{ width: 220, flexShrink: 0, overflowY: "auto" }}>
              <div style={{ fontSize: 12, color: "var(--on-surface-variant)", margin: "4px 0 8px" }}>Quality</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <FocusableButton focusKey="SOURCE_Q_ALL" style={chip(!qualities.length)} onClick={() => setQualities([])}>All</FocusableButton>
                {options.qualities.map((quality) => (
                  <FocusableButton key={quality} focusKey={`SOURCE_Q_${quality}`} style={chip(qualities.includes(quality))} onClick={() => setQualities(toggle(qualities, quality))}>
                    {qualityLabel(quality)}
                  </FocusableButton>
                ))}
              </div>
              <div style={{ fontSize: 12, color: "var(--on-surface-variant)", margin: "16px 0 8px" }}>Order</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <FocusableButton focusKey="SOURCE_SORT_SPEED" style={chip(sort === "speed")} onClick={() => setSort("speed")}>Fastest first</FocusableButton>
                <FocusableButton focusKey="SOURCE_SORT_QUALITY" style={chip(sort === "quality")} onClick={() => setSort("quality")}>Best quality first</FocusableButton>
              </div>
              <div style={{ fontSize: 12, color: "var(--on-surface-variant)", margin: "16px 0 8px" }}>Language</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <FocusableButton focusKey="SOURCE_L_ALL" style={chip(!languages.length)} onClick={() => setLanguages([])}>All</FocusableButton>
                {options.languages.map((language) => (
                  <FocusableButton key={language} focusKey={`SOURCE_L_${language}`} style={chip(languages.includes(language))} onClick={() => setLanguages(toggle(languages, language))}>
                    {languageLabel(language)}
                  </FocusableButton>
                ))}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 12, color: "var(--on-surface-variant)", marginBottom: 8 }}>
                {listed.length} of {streams.length} sources
                {checking ? " · checking which releases have peers…" : hiddenStreams.length ? ` · ${hiddenStreams.length} without peers hidden` : ""}
              </div>
              {progressText && (
                <div style={{ marginBottom: 10 }} aria-label={progressText}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ fontSize: 12, color: "var(--on-surface-variant)", flex: 1 }}>{progressText}</div>
                    {progress.tested > 0 && (
                      <FocusableButton focusKey="SOURCE_RECHECK" aria-label="Check the speed of these releases again" onClick={recheck} style={chip(false)}>
                        ↻ Recheck
                      </FocusableButton>
                    )}
                  </div>
                  <div style={{ height: 4, borderRadius: 2, marginTop: 4, background: "var(--surface-container-highest)", overflow: "hidden" }}>
                    <div style={{ height: 4, width: `${Math.round((100 * progress.tested) / progress.total)}%`, background: "var(--primary)", transition: "width 300ms" }} />
                  </div>
                </div>
              )}
              {hint && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, padding: 10, borderRadius: 12, background: "var(--surface-container-high)" }}>
                  <span style={{ flex: 1, fontSize: 13 }}>🐢 {hint.text}</span>
                  <FocusableButton focusKey="SOURCE_LANGUAGE_HINT" style={chip(true)} onClick={() => setChosen(defaultStreamFilters(streams, [hint.language]))}>
                    {hint.language === "EN" ? "Show English" : "Show Russian"}
                  </FocusableButton>
                </div>
              )}
              <div style={{ flex: 1, overflowY: "auto", paddingRight: 4 }}>
                {listed.map((stream, index) => {
                  const hash = streamInfoHash(stream);
                  const test = describeTest(freshResult(results, hash), Boolean(hash && running[hash]), hash ? live[hash] : undefined);
                  // Stable per release, so focus stays on it when the list re-sorts.
                  const itemKey = hash ? `${hash}_${stream.server}` : `${index}`;
                  return (
                  <FocusableButton
                    key={itemKey}
                    focusKey={`SOURCE_ITEM_${itemKey}`}
                    onClick={() => select(stream)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: 14,
                      marginBottom: 8,
                      borderRadius: 16,
                      border: "1px solid var(--outline-variant)",
                      background: "var(--surface-container-highest)",
                      color: "var(--on-surface)",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                      <Play size={18} color="var(--primary)" />
                      <span style={{ fontSize: 16, fontWeight: 600 }}>{stream.server}</span>
                    </div>
                    {stream.title && (
                      <div style={{ fontSize: 13, color: "var(--on-surface-variant)", marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                        {stream.title}
                      </div>
                    )}
                    {test && <TestResult line={test} />}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {streamBadges(stream).map((badge) => <Badge key={badge} text={badge} />)}
                    </div>
                  </FocusableButton>
                  );
                })}
                {!listed.length && (
                  <div style={{ color: "var(--on-surface-variant)", padding: 12 }}>
                    {streams.length ? "No matching sources. Change the quality or language filters." : "No servers available"}
                  </div>
                )}
                {hiddenStreams.length > 0 && (
                  <FocusableButton
                    focusKey="SOURCE_SHOW_HIDDEN"
                    onClick={() => setShowHidden((shown) => !shown)}
                    style={{ width: "100%", padding: 12, background: "transparent", border: "none", color: "var(--primary)", cursor: "pointer" }}
                  >
                    {showHidden ? "Hide releases without peers" : `Show ${hiddenStreams.length} releases without peers`}
                  </FocusableButton>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </FocusContext.Provider>
  );
};
