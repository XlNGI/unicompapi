import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPage, type ChatModelSelection } from '../../src/pages/chat/ChatPage';
import '../../src/styles/tokens.css';
import 'rsuite/dist/rsuite-no-reset.min.css';
import '../../src/styles/rsuite-bridge.css';
import '../../src/styles.css';

function NavigationFixture() {
  const parameters = new URLSearchParams(location.search);
  const [page, setPage] = useState('chat');
  const [conversationId, setConversationId] = useState<string | undefined>(parameters.get('conversationId') ?? undefined);
  const [model, setModel] = useState<ChatModelSelection | undefined>({ projectId: parameters.get('projectId')!,
    candidateId: parameters.get('candidateId')!, productFeature: 'text_chat' });
  return <>
    <nav style={{ height: 40 }}>
      <button id="fixture-leave" onClick={() => setPage('other')}>切换页面</button>
      <button id="fixture-return" onClick={() => setPage('chat')}>返回会话</button>
    </nav>
    <main style={{ height: 'calc(100vh - 40px)', display: 'grid' }}>
      {page === 'chat' ? <ChatPage initialConversationId={conversationId} onConversationChange={setConversationId}
        initialModelSelection={model} onModelSelectionChange={setModel} /> : <p>其他页面</p>}
    </main>
  </>;
}
createRoot(document.getElementById('root')!).render(<NavigationFixture />);
