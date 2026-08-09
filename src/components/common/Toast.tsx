import React, { useEffect } from 'react';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';

interface ToastProps {
  message: string | null;
  type?: 'success' | 'error' | 'info';
  onClose: () => void;
}

export const Toast: React.FC<ToastProps> = ({ message, type = 'success', onClose }) => {
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => {
        onClose();
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [message, onClose]);

  if (!message) return null;

  const isError = type === 'error';

  return (
    <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 z-50 transition-all duration-150">
      <div className={`flex items-center gap-3 px-5 py-3.5 border-2 text-xs font-black tracking-wider uppercase shadow-xl rounded-none ${
        isError 
          ? 'bg-rose-50 border-rose-400 text-rose-900' 
          : 'bg-emerald-50 border-emerald-400 text-emerald-950'
      }`}>
        {isError ? (
          <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
        ) : (
          <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
        )}
        <span>{message}</span>
        <button onClick={onClose} className="ml-3 hover:opacity-70">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
