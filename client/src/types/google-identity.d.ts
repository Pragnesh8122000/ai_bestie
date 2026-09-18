interface GoogleCredentialResponse {
  credential: string;
  select_by: string;
}

interface GoogleIdentityServices {
  accounts: {
    id: {
      initialize(config: {
        client_id: string;
        callback(response: GoogleCredentialResponse): void;
        ux_mode?: 'popup' | 'redirect';
      }): void;
      renderButton(
        parent: HTMLElement,
        options: {
          type?: 'standard' | 'icon';
          theme?: 'outline' | 'filled_blue' | 'filled_black';
          size?: 'large' | 'medium' | 'small';
          text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
          shape?: 'rectangular' | 'pill' | 'circle' | 'square';
          width?: number;
        },
      ): void;
    };
  };
}

interface Window {
  google?: GoogleIdentityServices;
}
