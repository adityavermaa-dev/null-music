import { useEffect, useState } from 'react';

export default function BootSequence({ children }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const minimum = setTimeout(() => setReady(true), 1100);
    const finishOnLoad = () => setReady(true);
    window.addEventListener('load', finishOnLoad);

    return () => {
      clearTimeout(minimum);
      window.removeEventListener('load', finishOnLoad);
    };
  }, []);

  return (
    <>
      {!ready && (
        <div className="boot-splash" role="status" aria-live="polite">
          <span className="boot-splash-orbit boot-splash-orbit--outer" aria-hidden="true" />
          <span className="boot-splash-orbit boot-splash-orbit--inner" aria-hidden="true" />
          <img src="/null-logo.svg" className="boot-splash-logo" alt="Null" />
          <span className="boot-splash-glow" aria-hidden="true" />
          <p className="boot-splash-label">Null</p>
        </div>
      )}
      <div className={`boot-splash-app ${ready ? 'boot-splash-app--ready' : ''}`}>
        {children}
      </div>
    </>
  );
}
