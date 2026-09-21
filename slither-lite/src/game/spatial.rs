use std::collections::{BTreeMap, HashMap};

use crate::protocol::EntityId;

use super::entities::{Food, Snake, Vec2};

const CELL_SIZE: f32 = 96.0;

#[derive(Default)]
pub struct SpatialIndex {
    food: HashMap<(i32, i32), Vec<EntityId>>,
    body: HashMap<(i32, i32), Vec<(EntityId, Vec2)>>,
}

impl SpatialIndex {
    pub fn build(snakes: &BTreeMap<EntityId, Snake>, food: &BTreeMap<EntityId, Food>) -> Self {
        let mut index = Self::default();
        for item in food.values() {
            index
                .food
                .entry(cell(item.position))
                .or_default()
                .push(item.id);
        }
        for snake in snakes.values() {
            for point in &snake.body {
                index
                    .body
                    .entry(cell(point.position))
                    .or_default()
                    .push((snake.id, point.position));
            }
        }
        index
    }

    pub fn nearby_food(&self, position: Vec2, radius: f32) -> Vec<EntityId> {
        query_cells(&self.food, position, radius)
            .flat_map(|items| items.iter().copied())
            .collect()
    }

    pub fn nearby_body(&self, position: Vec2, radius: f32) -> Vec<(EntityId, Vec2)> {
        query_cells(&self.body, position, radius)
            .flat_map(|items| items.iter().copied())
            .collect()
    }
}

fn query_cells<T>(
    cells: &HashMap<(i32, i32), Vec<T>>,
    position: Vec2,
    radius: f32,
) -> impl Iterator<Item = &Vec<T>> {
    let minimum = cell(Vec2 {
        x: position.x - radius,
        y: position.y - radius,
    });
    let maximum = cell(Vec2 {
        x: position.x + radius,
        y: position.y + radius,
    });
    (minimum.0..=maximum.0)
        .flat_map(move |x| (minimum.1..=maximum.1).map(move |y| (x, y)))
        .filter_map(|coordinate| cells.get(&coordinate))
}

fn cell(position: Vec2) -> (i32, i32) {
    (
        (position.x / CELL_SIZE).floor() as i32,
        (position.y / CELL_SIZE).floor() as i32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_values_across_negative_cell_boundaries() {
        let mut cells = HashMap::new();
        cells.insert((-1, 0), vec![7]);
        let values = query_cells(&cells, Vec2 { x: 1.0, y: 1.0 }, 5.0)
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(values, vec![7]);
    }
}
