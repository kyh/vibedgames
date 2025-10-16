import { ChatProvider } from "@/components/chat/chat-context";
import { ErrorMonitor } from "@/components/error-monitor/error-monitor";

export const dynamic = "force-dynamic";

const Layout = ({ children }: { children: React.ReactNode }) => {
  return (
    <ChatProvider>
      <ErrorMonitor>{children}</ErrorMonitor>
    </ChatProvider>
  );
};

export default Layout;
