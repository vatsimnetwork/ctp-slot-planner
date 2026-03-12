import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './SlotPlanner.css'
import App from './SlotPlanner.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
