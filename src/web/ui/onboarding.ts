// First-run onboarding tour. Shows a 4-step welcome modal the first time a
// browser opens the app, with a stable localStorage flag so it doesn't reappear
// on every reload. A "?" button in the topbar lets users re-open it.

const FLAG_KEY = 'urdf-studio:onboarded:v1';

interface Step {
  title: string;
  body: string;
  hint?: string;
}

const STEPS: Step[] = [
  {
    title: 'Welcome to URDF Studio',
    body: `Inspect, visualize, and play with ROS robot models — entirely in your browser.
           Nothing is uploaded; the page reads files from your computer using the File System Access API.`,
    hint: 'Press Esc or click outside to close. You can re-open this from the ? button later.'
  },
  {
    title: '1 · Open a folder',
    body: `Click <b>Open Folder</b> and pick the root of your ROS package or workspace.
           The app will scan for <code>package.xml</code>, <code>.urdf</code>, <code>.urdf.xacro</code>,
           <code>.xacro</code>, plus meshes (<code>.stl</code> / <code>.dae</code> / <code>.obj</code> /
           <code>.gltf</code> / <code>.glb</code>).`,
    hint: 'On Safari / mobile, use Pick Files instead — webkitdirectory fallback.'
  },
  {
    title: '2 · Drive the robot',
    body: `Pick a robot file from the dropdown. The right panel shows every movable joint with a slider
           and a numeric input. Click <b>Inspector</b> to see link details, <b>Checks</b> for URDF
           diagnostics, <b>Tools</b> for reachability sampling.`,
    hint: 'Switch render modes via the toolbar — Visual / Collision / Both.'
  },
  {
    title: '3 · Save and share',
    body: `<b>Save Pose</b> stores the current joint values + camera per-robot in your browser.
           <b>Save As</b> creates a named bookmark. The export buttons download a JSON pose or a PNG
           screenshot.
           <br><br>Read the <a href="./docs/" target="_blank" rel="noopener">Docs</a> for the full reference.`
  }
];

export function shouldShowOnboarding(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) !== '1';
  } catch {
    // Private mode with localStorage disabled — show every time. Acceptable.
    return true;
  }
}

export function markOnboardingSeen(): void {
  try {
    localStorage.setItem(FLAG_KEY, '1');
  } catch {
    // ignore
  }
}

export function clearOnboardingFlag(): void {
  try {
    localStorage.removeItem(FLAG_KEY);
  } catch {
    // ignore
  }
}

export function mountOnboarding(): { open(): void; close(): void } {
  // Create the dialog once and reuse it. Replacing innerHTML on every open
  // resets the step index cleanly.
  const dialog = document.createElement('dialog');
  dialog.id = 'onboarding-dialog';
  dialog.className = 'onboarding';
  dialog.setAttribute('aria-labelledby', 'onboarding-title');
  document.body.appendChild(dialog);

  let stepIndex = 0;

  function render(): void {
    const step = STEPS[stepIndex];
    const isLast = stepIndex === STEPS.length - 1;
    const dots = STEPS
      .map((_, i) => `<span class="onboarding-dot${i === stepIndex ? ' active' : ''}" data-step="${i}"></span>`)
      .join('');
    dialog.innerHTML = `
      <div class="onboarding-card">
        <div class="onboarding-step">Step ${stepIndex + 1} of ${STEPS.length}</div>
        <h2 id="onboarding-title">${step.title}</h2>
        <p>${step.body}</p>
        ${step.hint ? `<p class="onboarding-hint">${step.hint}</p>` : ''}
        <div class="onboarding-footer">
          <div class="onboarding-dots">${dots}</div>
          <div class="onboarding-actions">
            <button type="button" class="ghost" data-action="skip">${isLast ? 'Close' : 'Skip'}</button>
            <button type="button" data-action="back" ${stepIndex === 0 ? 'disabled' : ''}>Back</button>
            <button type="button" class="primary" data-action="next">${isLast ? 'Get started' : 'Next'}</button>
          </div>
        </div>
      </div>
    `;
    dialog.querySelector<HTMLButtonElement>('[data-action="next"]')?.focus();
  }

  function close(seen: boolean): void {
    if (seen) {
      markOnboardingSeen();
    }
    if (dialog.open) {
      dialog.close();
    }
  }

  dialog.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    if (target === dialog) {
      // Click on the backdrop.
      close(true);
      return;
    }
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'next') {
      if (stepIndex === STEPS.length - 1) {
        close(true);
      } else {
        stepIndex++;
        render();
      }
    } else if (action === 'back') {
      if (stepIndex > 0) {
        stepIndex--;
        render();
      }
    } else if (action === 'skip') {
      close(true);
    } else {
      const dot = target.closest<HTMLElement>('[data-step]');
      if (dot && dot.dataset.step) {
        stepIndex = Number(dot.dataset.step);
        render();
      }
    }
  });

  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close(true);
  });

  return {
    open(): void {
      stepIndex = 0;
      render();
      if (!dialog.open) {
        dialog.showModal();
      }
    },
    close(): void {
      close(false);
    }
  };
}
