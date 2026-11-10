import { gql } from "graphql-tag";

export const COACH_FIELDS = gql`
  fragment CoachFields on Coach {
    name
    nickname
  }
`;
