import React from "react";
import { Switch, Route, Redirect } from "react-router-dom";
import { ThemeProvider } from "styled-components";
import { Provider as AlertProvider, transitions, positions } from "react-alert";

import { ReactAlertTemplate } from "components";
import { lightTheme, darkTheme } from "styles/theme";
import { GlobalStyle } from "styles/global";

import { usePlayhouse } from "features/home/playhouseSlice";
import { Home } from "features/home/Home";
import { PackRoutes } from "features/packs/PackRoutes";
import { GameRoutes } from "features/game/GameRoutes";
import { AuthPage } from "features/auth/AuthPage";
import { ProfilePage } from "features/profile/ProfilePage";

const alertOptions = {
  position: positions.TOP_CENTER,
  transition: transitions.SCALE,
  timeout: 8000,
};

export const App: React.FC = () => {
  const { state } = usePlayhouse();
  return (
    <ThemeProvider theme={state.isDarkMode ? darkTheme : lightTheme}>
      <AlertProvider template={ReactAlertTemplate} {...alertOptions}>
        <GlobalStyle />
        <Switch>
          <Route exact path="/">
            <Home />
          </Route>
          <Route path="/game/:gameId">
            <GameRoutes />
          </Route>
          <Route path="/signup">
            <AuthPage />
          </Route>
          <Route path="/login">
            <AuthPage isLogin />
          </Route>
          <Route path="/packs">
            <PackRoutes />
          </Route>
          <Route path="/:username">
            <ProfilePage />
          </Route>
          <Redirect to="/" />
        </Switch>
      </AlertProvider>
    </ThemeProvider>
  );
};
