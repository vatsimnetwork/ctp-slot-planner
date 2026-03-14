import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './SlotPlanner.css'
import App from './SlotPlanner.jsx'
import '@fontsource/ubuntu';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
