import { createRoot } from 'react-dom/client'
import './styles/global.css'
import './lib/theme'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
