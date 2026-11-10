import { gql } from "graphql-tag";
import { COACH_FIELDS } from "./fragments";

export const RESOURCE_PAGE = gql`
  query ResourcePage($id: ID!) {
    Resource(id: $id) {
      title
      summary
      slug {
        current
      }
      coach {
        ...CoachFields
      }
    }
  }
  ${COACH_FIELDS}
`;
