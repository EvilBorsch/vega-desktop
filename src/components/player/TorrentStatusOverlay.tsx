import React, { useEffect, useState } from "react";

/**
 * What a starting torrent is doing (stage, peers, speed, time), so a slow
 * start is never a silent spinner.
 */
export const TorrentStatusOverlay: React.FC<{ title: string; detail: string; startedAt: number }> = ({
  title,
  detail,
  startedAt,
}) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div
      aria-live="polite"
      style={{
        position: "absolute",
        left: "50%",
        top: "62%",
        transform: "translateX(-50%)",
        zIndex: 94,
        pointerEvents: "none",
        textAlign: "center",
        padding: "10px 22px",
        borderRadius: 14,
        background: "rgba(0,0,0,0.6)",
        color: "#fff",
        maxWidth: "80%",
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
        {[detail, `${seconds} s`].filter(Boolean).join(" · ")}
      </div>
    </div>
  );
};
