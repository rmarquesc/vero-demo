export const createPrivateState = (credentialSecret) => ({ credentialSecret });

export const witnesses = {
  credentialSecret: ({ privateState }) => [
    privateState,
    privateState.credentialSecret
  ]
};
