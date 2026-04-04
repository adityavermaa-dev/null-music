import { useEffect, useState } from 'react';

export default function BootSequence({ children }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    
    const minimum = setTimeout(() => {
      if (mounted) triggerReady();
    }, 1100);

    const finishOnLoad = () => {
      if (mounted) triggerReady();
    };
    
    function triggerReady() {
      setReady(true);
      const globalSplash = document.getElementById('global-boot-splash');
      if (globalSplash) {
        globalSplash.classList.add('fade-out');
        setTimeout(() => {
          if (globalSplash.parentNode) {
            globalSplash.parentNode.removeChild(globalSplash);
          }
        }, 500); // Wait for fade-out animation to finish
      }
    }

    if (document.readyState === 'complete') {
      // Document is already loaded
    } else {
      window.addEventListener('load', finishOnLoad);
    }

    return () => {
      mounted = false;
      clearTimeout(minimum);
      window.removeEventListener('load', finishOnLoad);
    };
  }, []);

  return (
    <div className={`boot-splash-app ${ready ? 'boot-splash-app--ready' : ''}`}>
      {children}
    </div>
  );
}
