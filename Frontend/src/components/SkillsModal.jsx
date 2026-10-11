import React from 'react';
import { tx } from '../i18n-sweep';
import { getLang } from '../i18n';
import { X, Layers } from 'lucide-react';

export default function SkillsModal({ skillsOpen, setSkillsOpen, dbSkills }) {
  if (!skillsOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{backgroundColor:'rgba(0,0,0,.10)', transition:'background-color .2s'}} onClick={() => setSkillsOpen(false)}>
      <div className="rexi-lightfix bg-white border border-slate-200 rounded-2xl p-6 w-full max-w-lg max-h-[80vh] overflow-y-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-bold text-slate-800 flex items-center gap-2">
            <Layers size={16} className="text-purple-500" /> {tx(getLang(), 'Quản Lý Gói Kỹ Năng Agent (Skills Manager)')}
          </h2>
          <button onClick={() => setSkillsOpen(false)} className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-700"><X size={16} /></button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {dbSkills === null && <p className="text-xs text-red-500 col-span-2 text-center py-8">{tx(getLang(), 'Không thể tải skills')}</p>}
          {(!dbSkills || dbSkills.length === 0) && <p className="text-xs text-slate-500 col-span-2 text-center py-8">{tx(getLang(), 'Không có skills nào')}</p>}
          {(dbSkills || []).map(s => (
            <div key={s.ma_ky_nang} className="p-3 bg-slate-50 rounded-xl border border-slate-200 hover:border-purple-300 transition-all">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-600 font-mono">{s.ten_ky_nang}</span>
              </div>
              <p className="text-xs font-semibold text-slate-700">{tx(getLang(), s.tieu_de)}</p>
              <p className="text-[11px] text-slate-500 mt-1">{tx(getLang(), s.mo_ta)}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
