import { render } from 'preact';
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import './styles.css';
import { App } from './app';

render(<App />, document.getElementById('app')!);
