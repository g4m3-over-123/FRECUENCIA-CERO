import './ui/styles.css';
import { SceneManager } from './render/SceneManager.ts';
import { MonitorPanel } from './ui/MonitorPanel.ts';

function bootstrap(): void {
  const appRoot = document.getElementById('app');
  if (!appRoot) {
    throw new Error('Root element #app not found');
  }

  const viewport = document.createElement('div');
  viewport.className = 'scene-viewport';
  appRoot.appendChild(viewport);

  const hudContainer = document.createElement('div');
  hudContainer.className = 'hud-overlay';
  appRoot.appendChild(hudContainer);

  const sceneManager = new SceneManager(viewport);
  sceneManager.start();

  new MonitorPanel(hudContainer);
}

bootstrap();
