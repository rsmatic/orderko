/**
 * Says whether the screen is still keeping itself up to date.
 *
 * A list that quietly stopped updating looks exactly like a quiet shop, and
 * the difference matters when the thing you are waiting for is an order.
 */
export default function LiveDot({ live, checkedAt }) {
  const at = checkedAt
    ? checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <span
      className={`live-dot ${live ? '' : 'live-dot-off'}`}
      title={live
        ? `Updating automatically${at ? ` · last checked ${at}` : ''}`
        : "Can't reach the API — trying again"}
    >
      <span className="live-dot-mark" aria-hidden="true" />
      {live ? 'Live' : 'Offline'}
    </span>
  );
}
