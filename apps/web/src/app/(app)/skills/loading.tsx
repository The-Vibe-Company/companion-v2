export default function Loading() {
  return (
    <div className="page">
      <div className="pagehead">
        <div>
          <h1 className="pagehead__title">Skills</h1>
          <p className="pagehead__desc">Waiting for first poll…</p>
        </div>
      </div>
      <div className="cds-card cds-card__body--bare">
        <table className="tbl">
          <tbody>
            {Array.from({ length: 8 }).map((_, i) => (
              <tr key={i}>
                <td colSpan={6}>
                  <div
                    style={{
                      height: 16,
                      borderRadius: 4,
                      background: "var(--color-surface-raised)",
                      width: `${60 + ((i * 7) % 35)}%`,
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
