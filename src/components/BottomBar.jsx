import { useState, useRef, useEffect } from 'react'
import { Settings, LogOut, Save, FolderOpen, Minus, Maximize2, BookOpen, ChevronDown } from 'lucide-react'
import useTimelineStore from '../stores/timelineStore'
import useProjectStore from '../stores/projectStore'
import { useI18n } from '../i18n/I18nContext'
import StudioMark from '../studio/brand/StudioMark'

function BottomBar({ onOpenSettings, onOpenGettingStarted, projectName }) {
  const { t } = useI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)

  const { undo, redo, canUndo, canRedo } = useTimelineStore()
  const timelineHistoryLastChangedAt = useTimelineStore((state) => state.historyLastChangedAt)
  const {
    saveProject,
    closeProject,
    undoTimelineStructureChange,
    redoTimelineStructureChange,
    canUndoTimelineStructureChange,
    canRedoTimelineStructureChange,
    projectHistoryLastChangedAt,
  } = useProjectStore()
  const projectCanUndo = canUndoTimelineStructureChange()
  const projectCanRedo = canRedoTimelineStructureChange()
  const combinedCanUndo = projectCanUndo || canUndo()
  const combinedCanRedo = projectCanRedo || canRedo()

  const handleUndo = () => {
    if (projectCanUndo && (!canUndo() || projectHistoryLastChangedAt > timelineHistoryLastChangedAt)) {
      undoTimelineStructureChange()
      return
    }
    undo()
  }

  const handleRedo = () => {
    if (projectCanRedo && (!canRedo() || projectHistoryLastChangedAt > timelineHistoryLastChangedAt)) {
      redoTimelineStructureChange()
      return
    }
    redo()
  }

  useEffect(() => {
    if (!menuOpen) return
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false)
      }
    }
    window.addEventListener('click', handleClickOutside)
    return () => window.removeEventListener('click', handleClickOutside)
  }, [menuOpen])

  const handleLeave = () => {
    setMenuOpen(false)
    window.electronAPI?.closeWindow?.()
  }

  const handleSave = async () => {
    setMenuOpen(false)
    await saveProject()
  }

  const handleOpenSettings = () => {
    setMenuOpen(false)
    onOpenSettings?.()
  }

  const handleProjectSelection = async () => {
    setMenuOpen(false)
    await closeProject()
  }

  const handleOpenGettingStarted = () => {
    setMenuOpen(false)
    onOpenGettingStarted?.()
  }

  const handleMinimize = () => {
    setMenuOpen(false)
    window.electronAPI?.minimizeWindow?.()
  }

  const handleMaximize = () => {
    setMenuOpen(false)
    window.electronAPI?.toggleFullScreenWindow?.()
  }

  const Separator = () => (
    <div className="w-px h-4 bg-sf-dark-600 flex-shrink-0" aria-hidden="true" />
  )

  return (
    <div className="h-8 flex-shrink-0 bg-black border-t border-sf-dark-700 flex items-center justify-end px-3 gap-0">
      {/* Save | Undo | Redo | Project name | Settings */}
      <button
        onClick={handleSave}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-bold text-white hover:bg-sf-dark-800 transition-colors"
        title={t('bottomBar.saveProject')}
      >
        {t('common.save')}
      </button>
      <Separator />
      <button
        onClick={handleUndo}
        disabled={!combinedCanUndo}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-bold text-white hover:bg-sf-dark-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        title={`${t('bottomBar.undo')} (Ctrl+Z)`}
      >
        {t('bottomBar.undo')}
      </button>
      <Separator />
      <button
        onClick={handleRedo}
        disabled={!combinedCanRedo}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-bold text-white hover:bg-sf-dark-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        title={`${t('bottomBar.redo')} (Ctrl+Shift+Z)`}
      >
        {t('bottomBar.redo')}
      </button>
      <Separator />
      <div className="px-2 py-1 text-[11px] font-bold text-white truncate max-w-[180px]" title={projectName || t('bottomBar.untitled')}>
        {projectName || t('bottomBar.untitled')}
      </div>
      <Separator />
      {/* StorybookStudio - dropdown: Leave, Settings, Project Selection, Save Project (with dividers) */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="flex items-center gap-2 px-2 py-1 rounded text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800 transition-colors"
          title="StorybookStudio"
        >
          <StudioMark className="block h-[14px] w-[14px] flex-shrink-0" />
          <span className="text-[11px] font-semibold tracking-[-0.01em] text-sf-text-primary">StorybookStudio</span>
          <ChevronDown
            className={`h-3 w-3 flex-shrink-0 text-sf-text-muted transition-transform ${menuOpen ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>

        {menuOpen && (
          <div className="absolute bottom-full right-0 mb-1 w-48 py-1 bg-sf-dark-800 border border-sf-dark-600 rounded-lg shadow-xl z-50">
            <button
              onClick={handleLeave}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 transition-colors text-red-400 hover:text-red-300"
            >
              <LogOut className="w-3.5 h-3.5" />
              {t('bottomBar.leave')}
            </button>
            <div className="h-px bg-sf-dark-600 my-0.5 mx-2" />
            <button
              onClick={handleOpenGettingStarted}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 transition-colors"
            >
              <BookOpen className="w-3.5 h-3.5 text-sf-text-muted" />
              {t('bottomBar.gettingStarted')}
            </button>
            <div className="h-px bg-sf-dark-600 my-0.5 mx-2" />
            <button
              onClick={handleOpenSettings}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 transition-colors"
            >
              <Settings className="w-3.5 h-3.5 text-sf-text-muted" />
              {t('common.settings')}
            </button>
            <div className="h-px bg-sf-dark-600 my-0.5 mx-2" />
            <button
              onClick={handleMinimize}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 transition-colors"
            >
              <Minus className="w-3.5 h-3.5 text-sf-text-muted" />
              {t('bottomBar.minimize')}
            </button>
            <div className="h-px bg-sf-dark-600 my-0.5 mx-2" />
            <button
              onClick={handleMaximize}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 transition-colors"
            >
              <Maximize2 className="w-3.5 h-3.5 text-sf-text-muted" />
              {t('bottomBar.maximize')}
            </button>
            <div className="h-px bg-sf-dark-600 my-0.5 mx-2" />
            <button
              onClick={handleProjectSelection}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 transition-colors"
            >
              <FolderOpen className="w-3.5 h-3.5 text-sf-text-muted" />
              {t('bottomBar.projectSelection')}
            </button>
            <div className="h-px bg-sf-dark-600 my-0.5 mx-2" />
            <button
              onClick={handleSave}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 transition-colors"
            >
              <Save className="w-3.5 h-3.5 text-sf-text-muted" />
              {t('bottomBar.saveProject')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default BottomBar
