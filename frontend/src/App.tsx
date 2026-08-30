import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { ClaimsList } from './pages/ClaimsList'
import { CallHistory } from './pages/CallHistory'
import { Analytics } from './pages/Analytics'
import { AgentConfig } from './pages/AgentConfig'
import { ClaimDetail } from './pages/ClaimDetail'
import { ReviewQueue } from './pages/ReviewQueue'
import { Blockchain } from './pages/Blockchain'
import Landing from './pages/Landing'
import Verify from './pages/Verify'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        {/* Outside <Layout> on purpose. The dashboard chrome — sidebar, claim
            navigation, the call widget — frames a page as one screen of an
            internal tool, and this page's entire job is to be something an
            outsider can be handed as a URL. It stands alone. */}
        <Route path="/verify" element={<Verify />} />
        <Route element={<Layout />}>
          <Route path="/claims" element={<ClaimsList />} />
          <Route path="/review" element={<ReviewQueue />} />
          <Route path="/calls" element={<CallHistory />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/blockchain" element={<Blockchain />} />
          <Route path="/config" element={<AgentConfig />} />
          <Route path="/claims/:id" element={<ClaimDetail />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
