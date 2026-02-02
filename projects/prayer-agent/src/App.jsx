import { Routes, Route } from 'react-router-dom';
import { Home } from './pages/Home';
import { MyPrayers } from './pages/MyPrayers';

function App() {
    return (
        <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/my-prayers" element={<MyPrayers />} />
        </Routes>
    );
}

export default App;
