import type { Metadata } from 'next';
import './chat.css';
import { ChatApp } from '../../components/chat/ChatApp';

export const metadata: Metadata = {
  title: 'Octopus · Workspace',
};

export default function WorkspacePage() {
  return <ChatApp />;
}
