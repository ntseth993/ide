/**
 * NovaLink Live chat workspace.
 *
 * The three-column surface ordinary users see after signing in:
 * conversations sidebar, message thread, and a contextual right rail that
 * holds contact details / shared files. Only the sidebar and thread are
 * required at narrow widths; the rail collapses.
 *
 * Root owns the shared store subscription; this component is the layout and
 * a couple of local UI-only states (which conversation is active, whether the
 * Find People modal is open).
 */
import { useCallback, useState } from 'react';
import ConversationList from './ConversationList';
import MessageThread from './MessageThread';
import Composer from './Composer';
import UserDirectory from './UserDirectory';
import {
  setActiveConversation,
  selectActiveId,
  selectSelf,
  getSnapshot,
} from '../../services/novalinkLiveStore';

export default function ChatWorkspace({ status, getEditorSelection, onNotify }) {
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const snapshot = getSnapshot();
  const activeId = selectActiveId();
  const self = selectSelf();
  const contacts = snapshot.contacts || [];

  const handleSelect = useCallback((conversationId) => {
    setActiveConversation(conversationId);
  }, []);

  const handleNewConversation = useCallback(() => {
    setDirectoryOpen(true);
  }, []);

  const handleConversationStarted = useCallback((conversation) => {
    if (conversation?.id) setActiveConversation(conversation.id);
    onNotify?.({ tone: 'ok', message: 'Conversation opened.' });
  }, [onNotify]);

  return (
    <div className="novalink-workspace">
      <ConversationList
        activeId={activeId}
        onSelect={handleSelect}
        onNewConversation={handleNewConversation}
        selfId={self?.id}
      />
      <div className="novalink-main">
        <MessageThread conversationId={activeId} onNotify={onNotify} />
        <Composer
          conversationId={activeId}
          selfId={self?.id}
          getEditorSelection={getEditorSelection}
          onNotify={onNotify}
          active={Boolean(activeId)}
        />
      </div>
      <UserDirectory
        open={directoryOpen}
        onClose={() => setDirectoryOpen(false)}
        onConversationStarted={handleConversationStarted}
        selfId={self?.id}
        contacts={contacts}
        onNotify={onNotify}
      />
    </div>
  );
}
