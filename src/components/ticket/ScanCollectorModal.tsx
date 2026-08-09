import React, { useState } from 'react';
import { QrCode, X, CheckCircle2 } from 'lucide-react';
import { useTicketStore } from '../../store/useTicketStore';

interface ScanCollectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}

export const ScanCollectorModal: React.FC<ScanCollectorModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [scanInput, setScanInput] = useState('');
  const { tickets, markCollected } = useTicketStore();

  if (!isOpen) return null;

  const handleScanSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const query = scanInput.trim();
    if (!query) return;

    // Find ticket by composite ID or raw QR string
    const match = tickets.find(
      t => t.id.toLowerCase() === query.toLowerCase() || t.qrPayload.includes(query)
    );

    if (match) {
      if (match.status === 'void') {
        alert(`Cannot collect ticket #${match.id} because it was VOIDED.`);
        return;
      }
      await markCollected(match.id);
      onSuccess(`Ticket #${match.id} marked as COLLECTED`);
      setScanInput('');
      onClose();
    } else {
      alert(`Ticket #${query} not found`);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white border-2 border-slate-900 w-full max-w-md overflow-hidden shadow-2xl rounded-none">
        <div className="bg-slate-900 text-white px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-sm text-amber-400">
            <QrCode className="w-4 h-4" />
            <span>Scan / Collect Ticket</span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleScanSubmit} className="p-6">
          <p className="text-xs text-slate-600 font-semibold mb-4">
            Scan QR payload or type/paste composite ticket number to mark ticket collected.
          </p>

          <input
            type="text"
            value={scanInput}
            onChange={e => setScanInput(e.target.value)}
            placeholder="e.g. LOC01-DEV01-000001"
            className="w-full p-3 border-2 border-slate-300 rounded-none font-mono font-bold text-slate-900 focus:border-amber-500 focus:outline-none mb-4"
            autoFocus
          />

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-bold uppercase border border-slate-300 rounded-none text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!scanInput.trim()}
              className="flex items-center gap-1 px-4 py-2 text-xs font-black uppercase bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-none shadow-xs"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Mark Collected</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
