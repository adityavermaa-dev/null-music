import { Loader2, RefreshCw, AlertCircle, Music2 } from 'lucide-react';

export default function AsyncState({
  state = 'empty',
  title,
  message,
  onRetry,
  retryLabel = 'Retry',
  compact = false,
}) {
  const iconSize = compact ? 16 : 24;

  return (
    <div className={`async-state async-state--${state} ${compact ? 'async-state--compact' : ''}`}>
      <div className="async-state__icon" aria-hidden="true">
        {state === 'loading' && <Loader2 size={iconSize} className="spin-icon" />}
        {state === 'error' && <AlertCircle size={iconSize} />}
        {state === 'empty' && <Music2 size={iconSize} />}
      </div>
      <div className="async-state__content">
        {title && <h3 className="async-state__title">{title}</h3>}
        {message && <p className="async-state__message">{message}</p>}
      </div>
      {state === 'error' && onRetry && (
        <button className="async-state__retry" onClick={onRetry} type="button">
          <RefreshCw size={14} />
          {retryLabel}
        </button>
      )}
    </div>
  );
}
