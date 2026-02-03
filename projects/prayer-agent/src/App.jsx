import { Routes, Route } from 'react-router-dom';
import { Home } from './pages/Home';
import { MyPrayers } from './pages/MyPrayers';
import { Pricing } from './pages/Pricing';

function App() {
    return (
        <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/my-prayers" element={<MyPrayers />} />
            <Route path="/pricing" element={<Pricing />} />
        </Routes>
    );
}

export default App;
