import { useGameStore } from '../store/gameStore';
import { GamePage } from './pages/GamePage';
import { HomePage } from './pages/HomePage';
import { ReviewPage } from './pages/ReviewPage';

export function App() {
  const screen = useGameStore((store) => store.screen);
  if (screen === 'game') return <GamePage />;
  if (screen === 'review') return <ReviewPage />;
  return <HomePage />;
}
