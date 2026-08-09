import React, { useState, useEffect } from 'react';
import { Lock, X } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';

interface PinModalProps {
  isOpen: boolean;
  purpose: string | null;
  onClose: () => void;
}

export const PinModal: React.FC<PinModalProps> = ({ isOpen, purpose, onClose }) => {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const { validatePin } = useAuthStore();

  useEffect(() => {
    if (isOpen) {
      setPin('');
      setError(false);
    }
  }, [isOpen]);

  const handleKeyPress = (num: string) => {
    setPin(prev => {
      if (prev.length < 6) {
        setError(false);
        return prev + num;
      }
      return prev;
    });
  };

  const handleClear = () => {
    setPin('');
    setError(false);
  };

  const handleBackspace = () => {
    setPin(prev => prev.slice(0, -1));
    setError(false);
  };

  const handleSubmit = async () => {
    if (!pin) return;
    const isValid = await validatePin(pin);
    if (isValid) {
      setPin('');
      setError(false);
    } else {
      setError(true);
      setPin('');
    }
  };

  // Keyboard Event Listener for Physical Keyboard PIN Entry
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        handleKeyPress(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleBackspace();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, pin]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white border-2 border-slate-900 w-full max-w-sm overflow-hidden shadow-2xl rounded-none">
        <div className="bg-slate-900 text-white px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-sm text-amber-400">
            <Lock className="w-4 h-4" />
            <span>Manager Authorization</span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">
          <p className="text-xs font-bold text-slate-600 mb-4 text-center uppercase tracking-wide">
            {purpose || 'Manager PIN required for protected action'}
          </p>

          {/* PIN Input Display */}
          <div className={`mb-6 p-4 border-2 text-center transition-colors rounded-none ${
            error ? 'border-rose-500 bg-rose-50' : 'border-slate-300 bg-slate-50'
          }`}>
            <div className="flex justify-center items-center gap-3">
              {[...Array(4)].map((_, i) => (
                <div
                  key={i}
                  className={`w-4 h-4 border-2 transition-all rounded-none ${
                    i < pin.length
                      ? 'bg-amber-500 border-amber-600 scale-110'
                      : 'bg-slate-200 border-slate-300'
                  }`}
                />
              ))}
            </div>
            {error && (
              <div className="text-rose-600 text-xs font-bold mt-2 uppercase tracking-wide">
                Invalid Manager PIN (Try: 9999)
              </div>
            )}
          </div>

          {/* Keypad */}
          <div className="grid grid-cols-3 gap-2 mb-4">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '✓'].map(btn => (
              <button
                key={btn}
                onClick={() => {
                  if (btn === 'C') handleClear();
                  else if (btn === '✓') handleSubmit();
                  else handleKeyPress(btn);
                }}
                className={`py-3.5 text-lg font-black border-2 rounded-none transition active:scale-95 ${
                  btn === '✓'
                    ? 'bg-amber-500 text-white border-amber-600 hover:bg-amber-600'
                    : btn === 'C'
                    ? 'bg-rose-100 text-rose-700 border-rose-200 hover:bg-rose-200'
                    : 'bg-white text-slate-800 border-slate-200 hover:border-amber-400 hover:bg-amber-50'
                }`}
              >
                {btn}
              </button>
            ))}
          </div>

          <div className="text-[11px] text-center text-slate-500 font-mono">
            Type with Keyboard or Keypad • Default PIN: <span className="font-bold text-slate-800">9999</span>
          </div>
        </div>
      </div>
    </div>
  );
};
