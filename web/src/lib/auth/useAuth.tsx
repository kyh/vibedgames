import { useContext, createContext, useState, useEffect } from "react";
import type {
  SignUpWithPasswordCredentials,
  SignInWithPasswordCredentials,
  User,
  AuthError,
} from "@supabase/supabase-js";
import { supabase } from "~/utils/supabase";
import { useAlert } from "~/components";

type Context = {
  user: User | null;
  loading: boolean;
  signIn: typeof supabase.auth.signInWithPassword;
  signUp: typeof supabase.auth.signUp;
  signOut: typeof supabase.auth.signOut;
};

const AuthContext = createContext<Context | null>(null);

type Props = {
  children: React.ReactNode;
};

export const AuthProvider = ({ children }: Props) => {
  const alert = useAlert();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const getUser = async () => {
      const { data } = await supabase.auth.getUser();
      setUser(data.user);
      setLoading(false);
    };

    const { data: listener } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setUser(session?.user ?? null);
        setLoading(false);
      }
    );

    getUser();

    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

  const handleError = (error: AuthError) => {
    alert.show(error.message);
    setLoading(false);
  };

  const signUp = async (credentials: SignUpWithPasswordCredentials) => {
    setLoading(true);
    const response = await supabase.auth.signUp(credentials);
    if (response.error) handleError(response.error);

    return response;
  };

  const signIn = async (credentials: SignInWithPasswordCredentials) => {
    setLoading(true);
    const response = await supabase.auth.signInWithPassword(credentials);
    if (response.error) handleError(response.error);

    return response;
  };

  const signOut = async () => {
    setLoading(true);
    const response = await supabase.auth.signOut();
    if (response.error) handleError(response.error);

    return response;
  };

  return (
    <AuthContext.Provider
      value={{
        signUp,
        signIn,
        signOut,
        user,
        loading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext) as Context;
